'use server'

/**
 * Leads CRM server actions — the write path for /dashboard/leads.
 *
 * All mutations follow the house pattern (see dashboard/tasks/actions.ts):
 *   requirePermission → guard.ok check → createAdminClient → mutation →
 *   void logActivity(...) → revalidatePath → { ok, error?, data? }
 *
 * Reads stay in the server page; only writes (and the automation-rule CRUD)
 * live here. Status changes fan out to the shared automation engine
 * (runLeadAutomations) best-effort — an automation failure must never fail
 * the status change the user asked for.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { createNotification } from '@/lib/notifications/create'
import { runLeadAutomations } from '@/lib/integrations/meta/leads'
import { revalidatePath } from 'next/cache'

const REVALIDATE = '/dashboard/leads'

const LEAD_SOURCES = ['meta_lead_ad', 'manual', 'import', 'website', 'whatsapp', 'other'] as const
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'won', 'lost'] as const
export type LeadStatus = (typeof LEAD_STATUSES)[number]
export type LeadSource = (typeof LEAD_SOURCES)[number]

const RULE_TRIGGERS = ['lead_created', 'lead_status_changed', 'lead_uncontacted'] as const
const RULE_ACTIONS = ['assign_employee', 'create_task_request', 'notify_employees', 'notify_admins'] as const

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

/** Log a lead write onto the owning client's CRM timeline (house shape). */
function logLead(
  actorId: string | null | undefined,
  clientId: string | null,
  action: string,
  from: unknown,
  to: unknown,
): void {
  void logActivity({
    actorId: actorId ?? null,
    entityType: 'client',
    entityId: clientId,
    clientId,
    action,
    category: 'crm',
    detail: [{ field: 'lead', from, to }],
  })
}

// ── Create lead (manual entry) ────────────────────────────────────────────────

export interface CreateLeadInput {
  clientId: string
  fullName: string
  email?: string | null
  phone?: string | null
  source?: LeadSource
  notes?: string | null
}

export async function createLead(
  input: CreateLeadInput,
): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.LEADS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  if (!input.clientId) return { ok: false, error: 'Pick a client.' }
  const name = input.fullName?.trim()
  if (!name && !input.email?.trim() && !input.phone?.trim()) {
    return { ok: false, error: 'Give the lead at least a name, email or phone.' }
  }
  const source: LeadSource =
    input.source && (LEAD_SOURCES as readonly string[]).includes(input.source) ? input.source : 'manual'

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('leads')
    .insert({
      client_id: input.clientId,
      source,
      status: 'new',
      full_name: name || null,
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      notes: input.notes?.trim() || null,
      submitted_at: new Date().toISOString(),
      created_by: guard.employeeId ?? null,
    })
    .select('*')
    .single()
  if (error) return { ok: false, error: error.message }

  logLead(guard.employeeId, input.clientId, 'created', null, { name: name || input.email || input.phone, source })

  // Same fan-out a webhook lead gets — rules scoped to this client (or all
  // clients) with the lead_created trigger fire for manual leads too.
  try {
    await runLeadAutomations(admin as never, data, 'lead_created')
  } catch { /* automations are additive — never fail the create */ }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { id: (data as { id: string }).id } }
}

// ── Edit basic fields ─────────────────────────────────────────────────────────

export interface UpdateLeadPatch {
  full_name?: string | null
  email?: string | null
  phone?: string | null
  notes?: string | null
}

export async function updateLead(
  id: string,
  patch: UpdateLeadPatch,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.LEADS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: before } = await admin
    .from('leads')
    .select('id, client_id, full_name, email, phone, notes')
    .eq('id', id)
    .maybeSingle()
  if (!before) return { ok: false, error: 'Lead not found.' }

  // Only the whitelisted editable fields ever reach the update.
  const updates: Record<string, string | null> = {}
  if (patch.full_name !== undefined) updates.full_name = patch.full_name?.trim() || null
  if (patch.email !== undefined) updates.email = patch.email?.trim() || null
  if (patch.phone !== undefined) updates.phone = patch.phone?.trim() || null
  if (patch.notes !== undefined) updates.notes = patch.notes?.trim() || null
  if (Object.keys(updates).length === 0) return { ok: true }

  const { error } = await admin.from('leads').update(updates).eq('id', id)
  if (error) return { ok: false, error: error.message }

  logLead(guard.employeeId, before.client_id, 'edited',
    { name: before.full_name },
    { name: updates.full_name ?? before.full_name, fields: Object.keys(updates) })

  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ── Status change (drives the pipeline + automations) ────────────────────────

export async function updateLeadStatus(
  id: string,
  status: LeadStatus,
): Promise<ActionResult<{ first_contacted_at: string | null }>> {
  const guard = await requirePermission(PERMS.LEADS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  if (!(LEAD_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: 'Unknown status.' }
  }

  const admin = createAdminClient()
  const { data: lead } = await admin.from('leads').select('*').eq('id', id).maybeSingle()
  if (!lead) return { ok: false, error: 'Lead not found.' }
  if (lead.status === status) return { ok: true, data: { first_contacted_at: lead.first_contacted_at ?? null } }

  // Leaving 'new' means someone reached out — stamp the first contact once,
  // no matter which stage they jumped to.
  const updates: Record<string, string> = { status }
  let firstContactedAt: string | null = lead.first_contacted_at ?? null
  if (lead.status === 'new' && status !== 'new' && !lead.first_contacted_at) {
    firstContactedAt = new Date().toISOString()
    updates.first_contacted_at = firstContactedAt
  }

  const { error } = await admin.from('leads').update(updates).eq('id', id)
  if (error) return { ok: false, error: error.message }

  logLead(guard.employeeId, lead.client_id, 'edited', { status: lead.status }, { status })

  // Configurable rules ("qualified → create task request", …). Best-effort.
  try {
    await runLeadAutomations(
      admin as never,
      { ...lead, status, first_contacted_at: firstContactedAt },
      'lead_status_changed',
      { newStatus: status },
    )
  } catch { /* rules are additive — the status change already succeeded */ }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { first_contacted_at: firstContactedAt } }
}

// ── Assignment ────────────────────────────────────────────────────────────────

export async function assignLead(
  id: string,
  employeeId: string | null,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.LEADS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: lead } = await admin
    .from('leads')
    .select('id, client_id, full_name, campaign_name, assigned_to')
    .eq('id', id)
    .maybeSingle()
  if (!lead) return { ok: false, error: 'Lead not found.' }

  const { error } = await admin.from('leads').update({ assigned_to: employeeId }).eq('id', id)
  if (error) return { ok: false, error: error.message }

  logLead(guard.employeeId, lead.client_id, 'assigned',
    { assigned_to: lead.assigned_to ?? null }, { assigned_to: employeeId })

  // Tell the new owner. sourceKey dedupes a repeat assign to the same person.
  if (employeeId && employeeId !== lead.assigned_to) {
    void createNotification({
      employeeId,
      type: 'meta_lead_received',
      title: 'Lead assigned to you',
      message: `${lead.full_name || 'A lead'}${lead.campaign_name ? ` · ${lead.campaign_name}` : ''}`,
      link: '/dashboard/leads',
      sourceKey: `lead_assign:${id}:${employeeId}`,
    })
  }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deleteLead(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.LEADS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: lead } = await admin
    .from('leads')
    .select('id, client_id, full_name, email, source')
    .eq('id', id)
    .maybeSingle()
  if (!lead) return { ok: false, error: 'Lead not found.' }

  const { error } = await admin.from('leads').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }

  logLead(guard.employeeId, lead.client_id, 'deleted',
    { name: lead.full_name ?? lead.email, source: lead.source }, null)

  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ── Automation rules ──────────────────────────────────────────────────────────

export interface AutomationRuleInput {
  id?: string | null
  client_id: string | null             // NULL = applies to every client
  trigger: string                      // lead_created | lead_status_changed | lead_uncontacted
  condition: Record<string, unknown> | null
  action: string                       // assign_employee | create_task_request | notify_employees | notify_admins
  action_config: Record<string, unknown> | null
  is_active?: boolean
}

/** Validate the rule shape so a broken rule can never reach the engine. */
function validateRule(input: AutomationRuleInput): string | null {
  if (!(RULE_TRIGGERS as readonly string[]).includes(input.trigger)) return 'Pick a trigger.'
  if (!(RULE_ACTIONS as readonly string[]).includes(input.action)) return 'Pick an action.'
  if (input.trigger === 'lead_uncontacted') {
    const hours = Number((input.condition as { hours?: unknown } | null)?.hours)
    if (!Number.isFinite(hours) || hours <= 0) return 'Set how many hours a lead may stay uncontacted.'
  }
  const cfg = (input.action_config ?? {}) as { employee_id?: unknown; employee_ids?: unknown; title?: unknown }
  if (input.action === 'assign_employee' && !cfg.employee_id) return 'Pick the employee to assign.'
  if (input.action === 'notify_employees' && (!Array.isArray(cfg.employee_ids) || cfg.employee_ids.length === 0)) {
    return 'Pick at least one employee to notify.'
  }
  return null
}

export async function saveAutomationRule(
  input: AutomationRuleInput,
): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.LEADS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const invalid = validateRule(input)
  if (invalid) return { ok: false, error: invalid }

  const admin = createAdminClient()
  const row = {
    client_id: input.client_id || null,
    trigger: input.trigger,
    condition: input.condition ?? null,
    action: input.action,
    action_config: input.action_config ?? null,
    is_active: input.is_active ?? true,
  }

  let ruleId = input.id ?? null
  if (ruleId) {
    const { error } = await admin.from('lead_automation_rules').update(row).eq('id', ruleId)
    if (error) return { ok: false, error: error.message }
  } else {
    const { data, error } = await admin
      .from('lead_automation_rules')
      .insert({ ...row, created_by: guard.employeeId ?? null })
      .select('id')
      .single()
    if (error) return { ok: false, error: error.message }
    ruleId = (data as { id: string }).id
  }

  logLead(guard.employeeId, row.client_id, input.id ? 'edited' : 'created',
    input.id ? { automation_rule: input.id } : null,
    { automation_rule: ruleId, trigger: row.trigger, action: row.action })

  revalidatePath(REVALIDATE)
  return { ok: true, data: { id: ruleId! } }
}

export async function toggleAutomationRule(
  id: string,
  isActive: boolean,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.LEADS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: rule } = await admin
    .from('lead_automation_rules')
    .select('id, client_id, is_active')
    .eq('id', id)
    .maybeSingle()
  if (!rule) return { ok: false, error: 'Rule not found.' }

  const { error } = await admin.from('lead_automation_rules').update({ is_active: isActive }).eq('id', id)
  if (error) return { ok: false, error: error.message }

  logLead(guard.employeeId, rule.client_id ?? null, 'edited',
    { automation_rule: id, is_active: rule.is_active }, { automation_rule: id, is_active: isActive })

  revalidatePath(REVALIDATE)
  return { ok: true }
}

export async function deleteAutomationRule(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.LEADS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: rule } = await admin
    .from('lead_automation_rules')
    .select('id, client_id, trigger, action')
    .eq('id', id)
    .maybeSingle()
  if (!rule) return { ok: false, error: 'Rule not found.' }

  const { error } = await admin.from('lead_automation_rules').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }

  logLead(guard.employeeId, rule.client_id ?? null, 'deleted',
    { automation_rule: id, trigger: rule.trigger, action: rule.action }, null)

  revalidatePath(REVALIDATE)
  return { ok: true }
}
