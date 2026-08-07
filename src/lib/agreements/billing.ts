/**
 * Agreement fee billing — WHEN each agreement line's fee becomes an invoice line.
 *
 * Deliberately lives next to the progress engine and is built on its period
 * model, because the two must agree. Delivery counts against a *period*, and a
 * period owes exactly one fee. Bill per calendar month instead and a mid-month
 * start double-charges: Elara's agreement began 20 Jul, the progress engine
 * merges 20 Jul → 31 Aug into ONE cycle owing 15 posts, but a per-month biller
 * charges AED 400 in July and AED 400 in August for that single cycle.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * A term row's fee bills ONCE per delivery period, in the calendar month that
 * period ENDS. So:
 *   • Agreement starting on the 1st  → one fee per calendar month, as expected.
 *   • Agreement starting mid-month   → the stub month bills nothing; the merged
 *     first period bills one fee in the following month.
 *   • one_time item                  → bills once, in the period holding its
 *     effective_from — and when that is a mid-month stub, it rides along with
 *     the merged first cycle so the whole opening period is a single invoice
 *     rather than a stray part-month one.
 *
 * The invoice a fee lands on is the client-month draft for its billing month,
 * which by house convention is issued on the 1st of the FOLLOWING month. Elara's
 * opening cycle therefore bills in August and is issued 1 September, carrying
 * the AED 400 retainer and the AED 150 one-time brand identity together.
 *
 * Pure and framework-free so the cron, any backfill, and the tests share it.
 */

import { addMonth } from './progress'
import type { ClientAgreementRow, ClientAgreementItemRow } from './types'

/** The agreement's first calendar month, and whether it began mid-month. */
function startShape(agreement: Pick<ClientAgreementRow, 'start_date'>) {
  const startMonth = agreement.start_date.slice(0, 7)
  return {
    startMonth,
    midMonth: agreement.start_date.slice(8, 10) !== '01',
    mergedInto: addMonth(startMonth, 1),
  }
}

/**
 * The calendar month ('YYYY-MM') in which this term row's fee is invoiced, or
 * null when it never bills on its own (a retainer's stub month is not "null" —
 * it simply resolves to the merged month, so every caller gets one answer).
 */
export function feeBillingMonth(
  month: string,
  agreement: Pick<ClientAgreementRow, 'start_date' | 'end_date'>,
  termRow: Pick<ClientAgreementItemRow, 'commitment_type' | 'effective_from' | 'effective_to'>,
): string | null {
  const { startMonth, midMonth, mergedInto } = startShape(agreement)

  if (termRow.commitment_type === 'one_time') {
    const firstMonth = termRow.effective_from.slice(0, 7)
    // A one_time landing in the stub month has no invoice of its own to sit on.
    return midMonth && firstMonth === startMonth ? mergedInto : firstMonth
  }

  // Retainer. Before the agreement starts, nothing is owed.
  if (month < startMonth) return null
  // The stub month is merged forward — it owes no fee of its own.
  if (midMonth && month === startMonth) return mergedInto
  return month
}

/**
 * Does this term row's fee belong on `month`'s invoice?
 *
 * Callers must already have narrowed to agreements/term rows whose windows
 * overlap the month; this answers only the period question.
 */
export function feeBillsInMonth(
  month: string,
  agreement: Pick<ClientAgreementRow, 'start_date' | 'end_date'>,
  termRow: Pick<ClientAgreementItemRow, 'commitment_type' | 'effective_from' | 'effective_to'>,
): boolean {
  if (feeBillingMonth(month, agreement, termRow) !== month) return false

  // Never bill a month the agreement no longer covers.
  if (agreement.end_date && month > agreement.end_date.slice(0, 7)) return false

  // A retainer term row that closed before this month bills nothing further;
  // its successor (whose window does cover the month) bills instead.
  if (termRow.commitment_type !== 'one_time' && termRow.effective_to) {
    if (month > termRow.effective_to.slice(0, 7)) return false
  }
  return true
}

/**
 * Human label for the fee line, spelling out a merged opening period so the
 * client can see that one charge covers both part-months.
 *
 * `Retainer — Social Media Services (20 Jul – 31 Aug 2026)`
 */
export function feeLineDescription(
  month: string,
  agreement: Pick<ClientAgreementRow, 'start_date'>,
  termRow: Pick<ClientAgreementItemRow, 'commitment_type'>,
  serviceLabel: string,
): string {
  const { startMonth, midMonth, mergedInto } = startShape(agreement)
  const prefix = termRow.commitment_type === 'one_time' ? 'One-time' : 'Retainer'

  if (termRow.commitment_type !== 'one_time' && midMonth && month === mergedInto) {
    return `${prefix} — ${serviceLabel} (${fmtDay(agreement.start_date)} – ${fmtMonthEnd(mergedInto)})`
  }
  return `${prefix} — ${serviceLabel} (${fmtMonth(month)})`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function fmtMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${MONTHS[m - 1]} ${y}`
}

function fmtDay(date: string): string {
  const [, m, d] = date.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]}`
}

function fmtMonthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${last} ${MONTHS[m - 1]} ${y}`
}
