/** The kinds of recorded work an `activities` ownership program can count. Client-safe (no server imports). */

/**
 * Only kinds whose author is recorded reliably. Invoices are deliberately
 * absent: they record no creator and are made in bulk (Bulk Generate), so
 * "per item" would pay for one click.
 *
 * Tasks record no creator either, but entering one by hand (Add Task,
 * Duplicate, My Work) writes a "task created" activity event naming the
 * person; imports, the recurring cron and the Shortcuts API do not, so
 * `task_created` counts hand-entered tasks only.
 */
export const ACTIVITY_KINDS = {
  task_created:     { label: 'Tasks entered (Add Task, Duplicate)', singular: 'task' },
  cashbook_entry:   { label: 'Cash-book entries (not invoice payments)', singular: 'cash-book entry' },
  invoice_followup: { label: 'Invoice follow-ups logged', singular: 'follow-up' },
  request_created:  { label: 'Requests created', singular: 'request' },
  plan_item:        { label: 'Calendar items planned', singular: 'plan item' },
  social_post:      { label: 'Social posts prepared', singular: 'social post' },
  field_place:      { label: 'Field places added', singular: 'field place' },
} as const
export type ActivityKind = keyof typeof ACTIVITY_KINDS
export const isActivityKind = (k: string): k is ActivityKind => k in ACTIVITY_KINDS
