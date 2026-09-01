/**
 * The one place that decides what a line item's per-unit price IS.
 *
 * `invoice_items` stores `quantity`, `unit_price` and `total`, and the two are
 * supposed to satisfy total = quantity × unit_price. They do not always, and
 * the screen printed the contradiction verbatim: "2 × ₹600.00 = ₹600.00".
 *
 * `total` is the authoritative half. It is what the invoice's subtotal sums,
 * what the client is billed, and — verified across every mismatched row in
 * production — exactly the source task's billing_amount. `unit_price` is a
 * derived convenience that some older writes got wrong, storing the whole
 * amount instead of the per-unit share.
 *
 * So the per-unit price is DERIVED from the total rather than trusted from
 * storage. That has three consequences worth stating:
 *
 *   • the displayed arithmetic is always internally consistent,
 *   • no invoice amount changes anywhere — only the decomposition of one,
 *   • editing the rate still writes total = rate × quantity, so a row with a
 *     bad stored unit_price repairs itself the first time anyone touches it.
 *
 * Exact division is not always possible (₹2,300 over 12 units is ₹191.6666…),
 * so a printed rate rounded to paise multiplied back out can miss the total by
 * a paisa or two. That is inherent to showing a 2-decimal rate and is why the
 * TOTAL, never the rate, is the number that governs.
 */

export interface LineItemAmounts {
  quantity?: number | null
  unit_price?: number | null
  total?: number | null
}

const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/**
 * The per-unit price to SHOW for this line, or null when it cannot be known —
 * which happens legitimately for a viewer whose role has pricing stripped.
 * Callers render null as a dash; they must not print 0.
 */
export function unitPriceOf(item: LineItemAmounts | null | undefined): number | null {
  if (!item) return null
  const total = finite(item.total)
  const qty = finite(item.quantity)
  if (total !== null && qty !== null && qty > 0) return total / qty
  // No usable total (stripped, or a malformed row): fall back to what is
  // stored. Better a possibly-stale rate than nothing at all.
  return finite(item.unit_price)
}

/** True when the stored decomposition contradicts the total by more than paise. */
export function hasInconsistentUnitPrice(item: LineItemAmounts | null | undefined): boolean {
  if (!item) return false
  const total = finite(item.total)
  const qty = finite(item.quantity)
  const unit = finite(item.unit_price)
  if (total === null || qty === null || unit === null) return false
  // The slack has to scale with quantity, not be a flat paisa. A rate rounded
  // to two decimals is off by up to half a paisa PER UNIT, so eight units drift
  // up to 4p and twelve up to 6p — all of it produced by correct writers. A
  // flat tolerance flags those as broken and buries the real ones.
  const tolerance = Math.max(0.011, Math.abs(qty) * 0.005 + 0.001)
  return Math.abs(qty * unit - total) > tolerance
}
