/**
 * Which invoice a month's late work belongs on.
 * =============================================
 *
 * A task finished after its month's invoice went out has two possible homes:
 * the invoice the client is already holding, or a new one. Both generators used
 * to look only for an open DRAFT, so a month whose invoice had been SENT always
 * got a second invoice — for a client who pays whenever they like, that is the
 * ordinary case rather than the rare one, and it is how one month ends up
 * billed across INV-…-061A, -061-2 and -061-3.
 *
 * The rule, in one place so the server action and the screens cannot drift:
 * add to the invoice that exists whenever it can still take lines and is in the
 * same currency; otherwise raise a new one.
 */

import { buildBillingPeriod } from './numbering'
import type { CoveringInvoice, CoveringInvoiceMap } from './missed-tasks'

/** Statuses an invoice can take new lines in freely. */
export const ADD_LINES_OPEN = ['draft', 'reviewed'] as const

/** Statuses that can take new lines, but only with a reason for the history. */
export const ADD_LINES_WITH_REASON = ['sent', 'partial', 'overdue'] as const

/** The workflow in order, earliest first. */
const INVOICE_STATUS_ORDER = ['draft', 'reviewed', 'sent', 'partial', 'overdue', 'paid', 'closed'] as const

/**
 * How far along the workflow a status is — lower is earlier. An unknown status
 * ranks last so it never wins over a known one.
 */
export function statusRank(status: string): number {
  const i = (INVOICE_STATUS_ORDER as readonly string[]).indexOf(status)
  return i < 0 ? INVOICE_STATUS_ORDER.length : i
}

/** Can lines still be added to an invoice in this status, and on what terms? */
export function addLinesTerms(status: string): { editable: boolean; needsReason: boolean } {
  const open = (ADD_LINES_OPEN as readonly string[]).includes(status)
  const needsReason = (ADD_LINES_WITH_REASON as readonly string[]).includes(status)
  return { editable: open || needsReason, needsReason }
}

/** Describe one invoice row as the covering invoice for a month. */
export function coveringFrom(inv: {
  id: string
  invoice_number: string
  status: string
  currency?: string | null
}): CoveringInvoice {
  const { editable, needsReason } = addLinesTerms(inv.status)
  return {
    id: inv.id,
    invoice_number: inv.invoice_number,
    status: inv.status,
    currency: inv.currency ?? null,
    editable,
    needsReason,
  }
}

/**
 * The invoice a client+month group should ADD its tasks to, or undefined when
 * the group should get an invoice of its own.
 *
 * A draft is excluded on purpose: the generators already find and append to the
 * month's draft themselves, and that path also folds in the month's expenses,
 * which adding to a sent invoice deliberately does not.
 */
export function addsToExisting(
  covering: CoveringInvoice | undefined,
  groupCurrency: string | null | undefined,
): CoveringInvoice | undefined {
  if (!covering || covering.status === 'draft' || !covering.editable) return undefined
  // Lines carry the task's own currency; putting them on an invoice denominated
  // in another would label the amounts with the wrong symbol.
  if ((covering.currency || 'INR') !== (groupCurrency || 'INR')) return undefined
  return covering
}

/** One invoice row as the covering lookup reads it out of the database. */
export interface CoveringRow {
  id: string
  client_id: string | null
  invoice_number: string
  status: string
  currency?: string | null
  billing_period_start: string | null
}

/** The period start stored on the invoice for a `YYYY-MM` billing month. */
export function monthStart(month: string): string {
  return buildBillingPeriod(month).billing_period_start
}

/**
 * Fold invoice rows into `${client_id}__${month}` → the invoice covering that
 * month. `months` are the months the caller asked about; a row whose period
 * start is none of them is ignored, as is one with no client or no period.
 *
 * A month carrying more than one invoice — the duplicate this file exists to
 * stop — resolves to the earliest in the workflow: the one still open to lines
 * rather than a settled or supplementary one.
 */
export function pickCovering(rows: CoveringRow[], months: string[]): CoveringInvoiceMap {
  const monthOfStart = new Map(months.map(m => [monthStart(m), m]))
  const out: CoveringInvoiceMap = {}
  for (const row of rows) {
    if (!row.client_id || !row.billing_period_start) continue
    const month = monthOfStart.get(row.billing_period_start)
    if (!month) continue
    const key = `${row.client_id}__${month}`
    const held = out[key]
    if (!held || statusRank(row.status) < statusRank(held.status)) out[key] = coveringFrom(row)
  }
  return out
}
