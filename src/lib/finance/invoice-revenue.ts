/**
 * Finance Engine — how an invoice turns into revenue. The single source of
 * truth for bad debt and discounts, so no two reports can disagree again.
 *
 * Three statuses need care, and each is a different thing:
 *
 *   cancelled  — never really owed. Vanishes: no revenue, no loss.
 *   bad_debt   — DELIVERED, then never paid. The costs were spent and the staff
 *                earned commission on it, so we recognise only what was actually
 *                collected as revenue and report the shortfall as a LOSS. This is
 *                the one that used to silently inflate profit: counting the full
 *                billed amount makes a client who stiffed you look as profitable
 *                as one who paid.
 *   draft /    — not yet sent to the client. Not revenue, not a receivable.
 *   reviewed
 *
 * Discounts need no correction: `invoices.total_amount` is stored NET of the
 * discount (verified against discount_logs — a ₹2,550 job with ₹250 off stores
 * ₹2,300). So every report already reports post-discount revenue. What they lack
 * is VISIBILITY — the giveaway is invisible, absorbed into smaller revenue. Use
 * `discountGiven` for that, and prefer discount_logs: `invoices.discount_amount`
 * is overwritten by each new discount, so it undercounts an invoice discounted
 * twice.
 */

/** Voided — never owed, so it contributes nothing either way. */
export const CANCELLED_STATUS = 'cancelled'

/** Delivered, unpaid, written off. Revenue = what was collected; the rest is a loss. */
export const BAD_DEBT_STATUS = 'bad_debt'

/** Not yet sent to the client — neither revenue nor receivable. */
export const UNSENT_STATUSES = ['draft', 'reviewed']

export interface RevenueInvoice {
  status: string
  total_amount?: number | null
  paid_amount?: number | null
  total_amount_inr?: number | null
  paid_amount_inr?: number | null
  discount_amount?: number | null
}

const billedOf = (inv: RevenueInvoice) => Number(inv.total_amount_inr ?? inv.total_amount ?? 0)
const paidOf   = (inv: RevenueInvoice) => Number(inv.paid_amount_inr  ?? inv.paid_amount  ?? 0)

/** Does this invoice belong in revenue at all? (Cancelled and unsent do not.) */
export function isRevenueInvoice(inv: RevenueInvoice): boolean {
  return inv.status !== CANCELLED_STATUS && !UNSENT_STATUSES.includes(inv.status)
}

/**
 * Revenue we may honestly book for this invoice.
 *
 * Everything billed — EXCEPT on a write-off, where only what was actually
 * collected counts. Cancelled and unsent invoices contribute nothing.
 */
export function recognisedRevenue(inv: RevenueInvoice): number {
  if (!isRevenueInvoice(inv)) return 0
  if (inv.status === BAD_DEBT_STATUS) return paidOf(inv)
  return billedOf(inv)
}

/** Rupees delivered but never recovered — the write-off loss. Zero for everything else. */
export function badDebtLoss(inv: RevenueInvoice): number {
  if (inv.status !== BAD_DEBT_STATUS) return 0
  return Math.max(0, billedOf(inv) - paidOf(inv))
}

/**
 * Revenue given away on this invoice.
 *
 * Prefer a discount_logs total when you have one: `invoices.discount_amount` is
 * OVERWRITTEN by each new discount, so an invoice discounted twice reports only
 * the last one. Cancelled invoices gave nothing away — there was no sale.
 */
export function discountGiven(inv: RevenueInvoice, loggedTotal?: number): number {
  if (inv.status === CANCELLED_STATUS) return 0
  const fromLogs = Number(loggedTotal ?? 0)
  return Math.max(fromLogs, Number(inv.discount_amount ?? 0))
}

/** Cash actually received, including partial recoveries on written-off invoices. */
export function collectedAmount(inv: RevenueInvoice): number {
  if (inv.status === CANCELLED_STATUS) return 0
  return paidOf(inv)
}

/**
 * Billed and expected to be collected — the denominator of a collection rate.
 *
 * Write-offs BELONG here: a written-off invoice is a collection failure, not an
 * invoice that never existed. Leaving it out while its part-payments stay in the
 * numerator is what let the health page report a rate above 100%.
 */
export function billedForCollection(inv: RevenueInvoice): number {
  if (!isRevenueInvoice(inv)) return 0
  return billedOf(inv)
}
