/** The kinds of recorded work an `activities` ownership program can count. Client-safe (no server imports). */

/**
 * Only kinds whose author is recorded reliably. Invoices are deliberately
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
