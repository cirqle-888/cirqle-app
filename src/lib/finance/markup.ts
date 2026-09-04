/**
 * Expense markup — the "cushion" added to a client cost before it is rebilled.
 *
 * A cost recorded in the Cash Book against a client (printing, courier, a
 * stock photo) is rebilled on that client's invoice. Billing it at cost means
 * the agency carries the handling for free, so a percentage or a flat service
 * charge is added on top. That decision has two natural moments:
 *
 *   · when the expense is RECORDED  — you know what you paid and why, and the
 *     rebill rule for that client is fresh in mind; and
 *   · when the invoice is REVIEWED  — the older path, via Add Expenses.
 *
 * Both now compute through this one function, so the same cost and the same
 * cushion produce the same billed figure no matter which screen set it.
 *
 * Currency: markup is applied in whatever currency `original` is stated in.
 * A percentage is currency-agnostic; a FIXED markup is an amount in that same
 * currency, so callers must convert before or after consistently — never mix
 * a fixed markup stated in one currency with an original in another.
 */
import { round2 } from '@/lib/calculations/currency'

export type MarkupType = 'none' | 'percentage' | 'fixed'

export const MARKUP_TYPES: readonly MarkupType[] = ['none', 'percentage', 'fixed'] as const

export function isMarkupType(v: unknown): v is MarkupType {
  return typeof v === 'string' && (MARKUP_TYPES as readonly string[]).includes(v)
}

export interface MarkupResult {
  /** What the client is billed: original + markupAmount. */
  billed: number
  /** The cushion itself, in the same currency as `original`. */
  markupAmount: number
}

/**
 * Original cost + cushion. Returns the cost untouched for 'none', so an
 * unset markup is always a no-op rather than a silent zero-value markup.
 *
 * Rounding goes through round2 (epsilon-guarded), which is what the rest of
 * the ledger uses — the naive `Math.round(n * 100) / 100` disagrees at .xx5
 * midpoints, and a cushion is a figure a client sees on an invoice.
 */
export function computeMarkup(
  original: number,
  markupType: MarkupType | string | null | undefined,
  markupValue: number | null | undefined,
): MarkupResult {
  const orig = round2(original)
  const value = Number(markupValue) || 0

  if (markupType === 'percentage') {
    const markupAmount = round2(orig * value / 100)
    return { billed: round2(orig + markupAmount), markupAmount }
  }
  if (markupType === 'fixed') {
    const markupAmount = round2(value)
    return { billed: round2(orig + markupAmount), markupAmount }
  }
  return { billed: orig, markupAmount: 0 }
}

/** Short human label for a configured cushion, e.g. "15%" or "₹200". */
export function markupLabel(
  markupType: MarkupType | string | null | undefined,
  markupValue: number | null | undefined,
  currencySymbol = '₹',
): string | null {
  const value = Number(markupValue) || 0
  if (markupType === 'percentage' && value !== 0) return `${value}%`
  if (markupType === 'fixed' && value !== 0) return `${currencySymbol}${value.toLocaleString('en-IN')}`
  return null
}
