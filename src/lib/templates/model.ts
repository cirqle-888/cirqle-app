/**
 * Reusable client/service task templates.
 *
 * Cirqle already had exactly one: `BRAND_ONBOARDING_STEPS`, nine hard-coded
 * setup steps written into a new client's checklist by one button. It works,
 * and it proves the shape — a named list of steps, each with a title, a brief,
 * an assignee and a due date, written as requests and deduplicated by title so
 * re-running tops up instead of duplicating. What it could not do is be a
 * second template. Every agency has more than one repeatable job: a monthly
 * content cycle, a festival campaign, a new-outlet launch.
 *
 * So this is that one template generalised, with the three things the plan
 * asks for on top:
 *
 *   · RELATIVE due dates — a step is "three days after the run", not a fixed
 *     calendar date, so the same template works every month;
 *   · a PREVIEW — `planTemplateRun` returns exactly what would be created and
 *     what would be skipped, before anything is written;
 *   · NO DUPLICATES — the skip rule is the one the onboarding button already
 *     used, title-matched per client, lifted out so every template gets it.
 *
 * ── WHAT THIS IS NOT ──────────────────────────────────────────────────────
 *
 * Not a scheduler. The plan is explicit that recurring schedules stay in the
 * existing one (`/api/cron/recurring-tasks`), and nothing here has a cadence:
 * a template is run, by a person or by that cron, and this module only says
 * what one run produces.
 *
 * Pure and dependency-free, so the preview the user approves is computed by
 * the same function the server then executes.
 */

/** One step of a template. */
export interface TemplateStep {
  title: string
  description?: string
  /**
   * Days after the run date. 0 or absent means the run date itself; a
   * negative value is clamped to 0, since a step due before the job starts is
   * a typo rather than an intention.
   */
  dueOffsetDays?: number
  /** Overrides the run's default assignee for this step only. */
  assignedEmployeeId?: string | null
  priority?: string
  serviceId?: string | null
  /**
   * Complimentary work: assigned and tracked, never billed, never shown to
   * the client. The same flag the existing checklist items carry.
   */
  complimentary?: boolean
}

export interface TaskTemplate {
  /** Stable slug. Built-ins use a reserved `builtin:` prefix. */
  id: string
  name: string
  description?: string
  /** Offer it only for this client. Null/absent = any client. */
  clientId?: string | null
  /** Offer it only when this service is in play. Null/absent = any. */
  serviceId?: string | null
  steps: TemplateStep[]
}

export const BUILTIN_PREFIX = 'builtin:'
export const MAX_TEMPLATE_NAME = 60
export const MAX_TEMPLATE_STEPS = 50

export function isBuiltInTemplate(id: string): boolean {
  return id.startsWith(BUILTIN_PREFIX)
}

/** A step with its run-time values filled in. What the preview lists. */
export interface PlannedStep {
  title: string
  description: string
  /** ISO date (YYYY-MM-DD), or null when the template sets no due date. */
  dueDate: string | null
  assignedEmployeeId: string | null
  priority: string
  serviceId: string | null
  complimentary: boolean
}

export interface TemplateRunContext {
  /** Day 0 for every relative offset, as YYYY-MM-DD. */
  startDate: string
  /** Used by any step that does not name its own assignee. */
  defaultAssignedEmployeeId?: string | null
  /** Used by any step that does not name its own service. */
  defaultServiceId?: string | null
}

/**
 * Add whole days to a YYYY-MM-DD date and return the same format.
 *
 * Built in UTC on purpose: these are calendar dates, not instants, and doing
 * the arithmetic in the process's local zone is how "3 days later" becomes
 * 2 or 4 days later depending on which machine ran it. The rest of the app
 * resolves calendar dates the same way (see lib/utils/local-date).
 */
function addDays(date: string, days: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (!Number.isFinite(t)) return null
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10)
}

/** Fill in a template's steps for one run. */
export function resolveTemplateSteps(
  template: TaskTemplate,
  ctx: TemplateRunContext,
): PlannedStep[] {
  return template.steps.map(step => {
    const offset = Math.max(0, Math.trunc(step.dueOffsetDays ?? 0))
    return {
      title: step.title.trim(),
      description: (step.description ?? '').trim(),
      // A template with no offset at all still gets the run date, which is
      // what someone running "today's checklist" means.
      dueDate: addDays(ctx.startDate, offset),
      assignedEmployeeId: step.assignedEmployeeId ?? ctx.defaultAssignedEmployeeId ?? null,
      priority: step.priority || 'normal',
      serviceId: step.serviceId ?? ctx.defaultServiceId ?? null,
      complimentary: step.complimentary ?? false,
    }
  })
}

export interface TemplatePlan {
  /** Steps that would be created. */
  create: PlannedStep[]
  /** Steps already present for this client, by title. */
  skip: PlannedStep[]
}

/**
 * What a run would do — the preview, and the instruction.
 *
 * Deduplication is by trimmed, case-folded title within the client, which is
 * the rule the brand-onboarding button already used: a brand that arrives with
 * a Facebook page keeps that item ticked instead of collecting a duplicate.
 * It also makes a template safely re-runnable, which matters because "did that
 * already go in?" is exactly the question that produces two of everything.
 *
 * Steps that collide with each other inside one template are deduplicated too
 * — a hand-edited template with the same title twice would otherwise create
 * two rows on its first run and one on every run after.
 */
export function planTemplateRun(
  steps: readonly PlannedStep[],
  existingTitles: readonly string[],
): TemplatePlan {
  const seen = new Set(existingTitles.map(t => t.trim().toLowerCase()).filter(Boolean))
  const create: PlannedStep[] = []
  const skip: PlannedStep[] = []
  for (const step of steps) {
    const key = step.title.trim().toLowerCase()
    if (!key) continue // an untitled step is nothing to create
    if (seen.has(key)) { skip.push(step); continue }
    seen.add(key)
    create.push(step)
  }
  return { create, skip }
}

/**
 * Templates worth offering in this context, most specific first.
 *
 * A template pinned to this client, then one pinned to this service, then the
 * general ones — so the list someone sees while standing on a client is
 * ordered by how likely it is to be the one they want, rather than
 * alphabetically.
 */
export function templatesFor(
  all: readonly TaskTemplate[],
  ctx: { clientId?: string | null; serviceId?: string | null },
): TaskTemplate[] {
  const rank = (t: TaskTemplate): number => {
    if (t.clientId && t.clientId === ctx.clientId) return 0
    if (t.serviceId && t.serviceId === ctx.serviceId) return 1
    if (!t.clientId && !t.serviceId) return 2
    return 3 // pinned to a different client or service
  }
  return all
    .map(t => ({ t, r: rank(t) }))
    .filter(x => x.r < 3)
    .sort((a, b) => (a.r === b.r ? a.t.name.localeCompare(b.t.name) : a.r - b.r))
    .map(x => x.t)
}

export type TemplateValidation =
  | { ok: true; template: TaskTemplate }
  | { ok: false; errors: string[] }

/**
 * Check and normalise a template before it is stored.
 *
 * Templates are stored as JSON in `company_settings`, so nothing in the
 * database constrains their shape — this is the only gate, and it runs on the
 * server before every write.
 */
export function validateTemplate(input: unknown): TemplateValidation {
  const errors: string[] = []
  const raw = (input ?? {}) as Partial<TaskTemplate>

  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!id) errors.push('The template needs an id.')
  if (id && isBuiltInTemplate(id)) errors.push('That id is reserved for built-in templates.')

  const name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim() : ''
  if (!name) errors.push('Give the template a name.')
  if (name.length > MAX_TEMPLATE_NAME) errors.push(`Keep the name under ${MAX_TEMPLATE_NAME} characters.`)

  const rawSteps = Array.isArray(raw.steps) ? raw.steps : []
  if (rawSteps.length === 0) errors.push('A template needs at least one step.')
  if (rawSteps.length > MAX_TEMPLATE_STEPS) errors.push(`A template can hold at most ${MAX_TEMPLATE_STEPS} steps.`)

  const steps: TemplateStep[] = []
  for (const s of rawSteps.slice(0, MAX_TEMPLATE_STEPS)) {
    const step = (s ?? {}) as Partial<TemplateStep>
    const title = typeof step.title === 'string' ? step.title.replace(/\s+/g, ' ').trim() : ''
    if (!title) { errors.push('Every step needs a title.'); continue }
    steps.push({
      title,
      description: typeof step.description === 'string' ? step.description.trim() : '',
      dueOffsetDays: Math.max(0, Math.trunc(Number(step.dueOffsetDays) || 0)),
      assignedEmployeeId: step.assignedEmployeeId || null,
      priority: typeof step.priority === 'string' && step.priority ? step.priority : 'normal',
      serviceId: step.serviceId || null,
      complimentary: !!step.complimentary,
    })
  }

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    template: {
      id,
      name,
      description: typeof raw.description === 'string' ? raw.description.trim() : '',
      clientId: raw.clientId || null,
      serviceId: raw.serviceId || null,
      steps,
    },
  }
}

/** Read the stored JSON blob, tolerating anything that is not a template list. */
export function parseStoredTemplates(raw: string | null | undefined): TaskTemplate[] {
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const out: TaskTemplate[] = []
  for (const item of parsed) {
    const v = validateTemplate(item)
    if (v.ok) out.push(v.template)
  }
  return out
}
