'use server'

/**
 * Task-template server actions.
 *
 * ── WHERE TEMPLATES LIVE, AND WHY ─────────────────────────────────────────
 *
 * In `company_settings` under one key, as a JSON array. Not in a table of
 * their own, because this pass is explicitly not allowed to change the
 * production schema (see docs/PRODUCTIVITY-IMPROVEMENTS.md: "No production
 * schema changes or database resets were performed in this pass"). A handful
 * of named step lists is well within what a settings row holds, the shape is
 * validated on every read and every write by `validateTemplate`, and moving
 * them to a real table later is a migration plus a swap of the two functions
 * at the top of this file — nothing else here changes.
 *
 * ── WHAT A RUN WRITES ─────────────────────────────────────────────────────
 *
 * Rows in `task_requests`, exactly as the brand-onboarding button already
 * did: a request becomes a task only when somebody presses Start, so running
 * a template cannot create billable work by itself. That is the property
 * worth keeping — a template is a list of things to do, not an invoice.
 *
 * `previewTemplateRun` and `runTemplate` compute their plan with the SAME
 * pure function, so the list the user approves is the list that gets written.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission, requireReadPermission } from '@/lib/permissions/check'
import { logActivity } from '@/lib/activity/log'
import { PERMS } from '@/lib/permissions/keys'
import { revalidatePath, revalidateTag } from 'next/cache'
import { COMPANY_SETTINGS_TAG } from '@/lib/settings/company-settings'
import { REQUEST_KIND_CHECKLIST, REQUEST_KIND_REQUEST, BRAND_ONBOARDING_STEPS } from '@/lib/requests/kind'
import { todayISO } from '@/lib/utils/local-date'
import {
  parseStoredTemplates, validateTemplate, resolveTemplateSteps, planTemplateRun,
  isBuiltInTemplate, BUILTIN_PREFIX,
  type TaskTemplate, type TemplatePlan,
} from './model'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

const SETTINGS_KEY = 'task_templates'
const REVALIDATE = '/dashboard/requests'

/**
 * The templates that ship with the app.
 *
 * Brand onboarding is here rather than left as its own code path, so the one
 * template that already existed and every template added since run through
 * the same preview, the same duplicate rule and the same writer. Built-ins
 * cannot be edited or deleted — `validateTemplate` refuses the reserved id
 * prefix — which is also why the old button keeps working unchanged.
 */
export const BUILT_IN_TEMPLATES: readonly TaskTemplate[] = [
  {
    id: `${BUILTIN_PREFIX}brand-onboarding`,
    name: 'Brand onboarding',
    description: 'Everything a new brand needs before design work can start.',
    steps: BRAND_ONBOARDING_STEPS.map(step => ({
      title: step.title,
      description: step.description,
      complimentary: true,
    })),
  },
]

async function readTemplates(): Promise<TaskTemplate[]> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('company_settings')
    .select('value')
    .eq('key', SETTINGS_KEY)
    .maybeSingle()
  return parseStoredTemplates((data?.value as string | undefined) ?? null)
}

async function writeTemplates(templates: TaskTemplate[]): Promise<string | null> {
  const admin = createAdminClient()
  const { error } = await admin
    .from('company_settings')
    .upsert({ key: SETTINGS_KEY, value: JSON.stringify(templates) }, { onConflict: 'key' })
  if (error) return error.message
  // Same cache the settings page busts — templates are read through it.
  revalidateTag(COMPANY_SETTINGS_TAG, 'max')
  return null
}

/**
 * Every template this viewer may run: the built-ins plus the stored ones.
 *
 * Gated on `requests.manage`, the same permission the brand-onboarding button
 * required, because running a template writes requests for other people.
 */
export async function listTemplates(): Promise<ActionResult<TaskTemplate[]>> {
  // Read guard, not the write guard: this only lists, and the write guard
  // refuses during an access preview — which would show an admin previewing a
  // role a broken panel rather than a narrower one.
  const guard = await requireReadPermission(PERMS.REQUESTS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  return { ok: true, data: [...BUILT_IN_TEMPLATES, ...(await readTemplates())] }
}

export async function saveTemplate(input: unknown): Promise<ActionResult<TaskTemplate>> {
  const guard = await requirePermission(PERMS.REQUESTS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const v = validateTemplate(input)
  if (!v.ok) return { ok: false, error: v.errors.join(' ') }

  const existing = await readTemplates()
  const next = existing.some(t => t.id === v.template.id)
    ? existing.map(t => (t.id === v.template.id ? v.template : t))
    : [...existing, v.template]

  const err = await writeTemplates(next)
  if (err) return { ok: false, error: err }

  void logActivity({
    actorId: guard.employeeId, entityType: 'setting', action: 'changed',
    detail: { label: `task template: ${v.template.name}`, steps: v.template.steps.length },
  })
  revalidatePath(REVALIDATE)
  return { ok: true, data: v.template }
}

export async function deleteTemplate(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.REQUESTS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (isBuiltInTemplate(id)) return { ok: false, error: 'Built-in templates cannot be deleted.' }

  const existing = await readTemplates()
  if (!existing.some(t => t.id === id)) return { ok: true } // already gone

  const err = await writeTemplates(existing.filter(t => t.id !== id))
  if (err) return { ok: false, error: err }

  void logActivity({
    actorId: guard.employeeId, entityType: 'setting', action: 'deleted',
    detail: { label: `task template: ${id}` },
  })
  revalidatePath(REVALIDATE)
  return { ok: true }
}

export interface TemplateRunInput {
  templateId: string
  clientId: string
  /** Day 0 for the relative offsets. Defaults to today. */
  startDate?: string
  /** Used by any step that does not name its own assignee. */
  assignedEmployeeId?: string | null
  serviceId?: string | null
}

async function buildPlan(
  input: TemplateRunInput,
): Promise<{ plan: TemplatePlan; template: TaskTemplate } | { error: string }> {
  const all = [...BUILT_IN_TEMPLATES, ...(await readTemplates())]
  const template = all.find(t => t.id === input.templateId)
  if (!template) return { error: 'That template no longer exists.' }
  if (template.clientId && template.clientId !== input.clientId) {
    return { error: 'That template belongs to a different client.' }
  }

  const steps = resolveTemplateSteps(template, {
    startDate: input.startDate || todayISO(),
    defaultAssignedEmployeeId: input.assignedEmployeeId ?? null,
    defaultServiceId: input.serviceId ?? template.serviceId ?? null,
  })

  // What this client already has, so a re-run tops up rather than duplicates.
  // Titles only — the dedupe rule needs nothing else, and selecting less is
  // one fewer column to be wrong about.
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('task_requests')
    .select('title')
    .eq('client_id', input.clientId)
  if (error) return { error: 'Could not read this client’s existing items.' }

  return {
    template,
    plan: planTemplateRun(steps, (data ?? []).map((r: { title: string }) => r.title)),
  }
}

/**
 * What a run would create and what it would skip — without writing anything.
 *
 * The plan asks to "preview the resulting tasks and avoid duplicate
 * creation"; this is the preview, and `runTemplate` recomputes the identical
 * plan rather than trusting a client-supplied list.
 */
export async function previewTemplateRun(
  input: TemplateRunInput,
): Promise<ActionResult<{ templateName: string; plan: TemplatePlan }>> {
  // Reads only — see listTemplates. `runTemplate` keeps the write guard.
  const guard = await requireReadPermission(PERMS.REQUESTS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!input.clientId) return { ok: false, error: 'Pick a client first.' }

  const built = await buildPlan(input)
  if ('error' in built) return { ok: false, error: built.error }
  return { ok: true, data: { templateName: built.template.name, plan: built.plan } }
}

export async function runTemplate(
  input: TemplateRunInput,
): Promise<ActionResult<{ created: number; skipped: number }>> {
  const guard = await requirePermission(PERMS.REQUESTS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!input.clientId) return { ok: false, error: 'Pick a client first.' }

  // Recomputed server-side, deliberately: the preview the user saw is advice,
  // and a client that posted its own list of rows to create would be writing
  // straight past the duplicate rule.
  const built = await buildPlan(input)
  if ('error' in built) return { ok: false, error: built.error }
  const { plan, template } = built

  if (plan.create.length === 0) {
    return { ok: true, data: { created: 0, skipped: plan.skip.length } }
  }

  const now = new Date().toISOString()
  const rows = plan.create.map(step => ({
    source: 'manual',
    // Complimentary steps become checklist items (never billed, never shown
    // to the client); everything else is an ordinary request.
    kind: step.complimentary ? REQUEST_KIND_CHECKLIST : REQUEST_KIND_REQUEST,
    client_id: input.clientId,
    title: step.title,
    description: step.description || null,
    status: 'submitted',
    client_status: 'submitted',
    priority: step.priority,
    due_date: step.dueDate,
    service_id: step.serviceId,
    assigned_employee_id: step.assignedEmployeeId,
    last_staff_viewed_at: now,
  }))

  const admin = createAdminClient()
  const { error } = await admin.from('task_requests').insert(rows)
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId: guard.employeeId, entityType: 'client', entityId: input.clientId,
    action: 'created', category: 'crm', clientId: input.clientId,
    note: `${template.name} — ${rows.length} item${rows.length === 1 ? '' : 's'}`,
    detail: { template: template.id, created: rows.length, skipped: plan.skip.length },
  })

  revalidatePath(REVALIDATE)
  return { ok: true, data: { created: rows.length, skipped: plan.skip.length } }
}
