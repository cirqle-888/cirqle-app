/** The kinds of recorded work an `activities` ownership program can count. Client-safe (no server imports). */

/**
 * Built-in kinds: measured from their own tables, where the author is recorded reliably. Invoices are deliberately
 * absent: they record no creator and are made in bulk (Bulk Generate), so
 * "per item" would pay for one click.
 *
 * Tasks record no creator either, but entering one by hand (Add Task,
 * Duplicate) writes a "task created" activity event naming the person;
 * imports, the recurring cron and the Shortcuts API do not. My Work also logs
 * one when Start auto-creates a task from an assigned request — that is work
 * begun, not a task entered, and is excluded. So `task_created` counts
 * hand-entered tasks only.
 */
export const ACTIVITY_KINDS = {
  task_created:       { label: 'Tasks entered (Add Task, Duplicate)', singular: 'task' },
  contribution_saved: { label: 'Contributions recorded (per task)', singular: 'task scored' },
  cashbook_entry:     { label: 'Cash-book entries (not invoice payments)', singular: 'cash-book entry' },
  invoice_followup:   { label: 'Invoice follow-ups logged', singular: 'follow-up' },
  request_created:    { label: 'Requests created', singular: 'request' },
  plan_item:          { label: 'Calendar items planned', singular: 'plan item' },
  social_post:        { label: 'Social posts prepared', singular: 'social post' },
  field_place:        { label: 'Field places added', singular: 'field place' },
} as const
export type BuiltInActivityKind = keyof typeof ACTIVITY_KINDS
/** A built-in kind, or `log:<entity>.<action>` read straight from the activity log. */
export type ActivityKind = BuiltInActivityKind | `log:${string}`

// ── Kinds discovered from the activity log ──────────────────────────────────
//
// Every action the app logs with an actor (`logActivity`) can be paid per
// item without code: the picker lists each (entity, action) pair the log has
// actually recorded, so a new feature that logs its work shows up here on its
// own. Each item (entity) counts once per person per period.

export const LOG_KIND_PREFIX = 'log:'

/** Pairs a built-in kind already measures (better), so they are not offered twice. */
const COVERED_BY_BUILT_IN = new Set([
  'task.created', 'task.contribution_saved', 'task.contribution_corrected_closed_period',
  'cashbook.created', 'cashbook.expense_added', 'cashbook.payment_received', 'invoice.payment_received',
  'field_place.created',
])
/** Entities that are administration or system, not work to pay per item. */
const NOT_WORK_ENTITIES = new Set(['auth', 'payroll', 'setting', 'employee', 'other'])
/** Actions that undo, hide or are done by the system. */
const NOT_WORK_ACTIONS = /delet|archiv|restor|lock|auto|sync|recalc|refresh/i

/** May this logged pair be offered (and counted) as an ownership activity? */
export function isPayableLogPair(entityType: string, action: string): boolean {
  if (!entityType || !action) return false
  if (NOT_WORK_ENTITIES.has(entityType)) return false
  if (NOT_WORK_ACTIONS.test(action)) return false
  return !COVERED_BY_BUILT_IN.has(`${entityType}.${action}`)
}

export const logKind = (entityType: string, action: string): ActivityKind => `log:${entityType}.${action}`

export function parseLogKind(kind: string): { entityType: string; action: string } | null {
  const m = /^log:([a-z0-9_]+)\.([a-z0-9_.]+)$/.exec(kind)
  return m ? { entityType: m[1], action: m[2] } : null
}

const words = (s: string) => s.replace(/[._]+/g, ' ').trim()
const ENTITY_NOUN: Record<string, string> = {
  task: 'Task', client: 'Client', invoice: 'Invoice', portfolio_item: 'Portfolio item',
  message: 'Chat message', project: 'Project', social_account: 'Social account',
  job_application: 'Job application', job_position: 'Job position', approval: 'Approval',
  quotation: 'Quotation', note: 'Note', field_place: 'Field place', cashbook: 'Cash-book',
}

/** Actions whose bare name reads badly as a label. */
const ACTION_WORDS: Record<string, string> = { note: 'note added' }

/** "Portfolio item · created", "Task · status changed". */
export function logKindLabel(entityType: string, action: string): string {
  return `${ENTITY_NOUN[entityType] ?? words(entityType).replace(/^./, c => c.toUpperCase())} · ${ACTION_WORDS[action] ?? words(action)}`
}

export const isActivityKind = (k: string): k is ActivityKind => {
  if (k in ACTIVITY_KINDS) return true
  const p = parseLogKind(k)
  return !!p && isPayableLogPair(p.entityType, p.action)
}

/** Label for any kind, built-in or from the log. */
export function activityKindLabel(k: string): string {
  if (k in ACTIVITY_KINDS) return ACTIVITY_KINDS[k as BuiltInActivityKind].label
  const p = parseLogKind(k)
  return p ? logKindLabel(p.entityType, p.action) : k
}
