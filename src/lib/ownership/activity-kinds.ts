/** The kinds of recorded work an `activities` ownership program can count. Client-safe (no server imports). */

/**
 * Only kinds whose row records WHO did it, reliably. Tasks and invoices are
 * deliberately absent: neither records its creator, and both are made in bulk
 * (imports, Bulk Generate), so "per item" would pay for one click.
 */
export const ACTIVITY_KINDS = {
  cashbook_entry:   { label: 'Cash-book entries (not invoice payments)', singular: 'cash-book entry' },
  invoice_followup: { label: 'Invoice follow-ups logged', singular: 'follow-up' },
  request_created:  { label: 'Requests created', singular: 'request' },
  plan_item:        { label: 'Calendar items planned', singular: 'plan item' },
  social_post:      { label: 'Social posts prepared', singular: 'social post' },
  field_place:      { label: 'Field places added', singular: 'field place' },
} as const
export type ActivityKind = keyof typeof ACTIVITY_KINDS
export const isActivityKind = (k: string): k is ActivityKind => k in ACTIVITY_KINDS
