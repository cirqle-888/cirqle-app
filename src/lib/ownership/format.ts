/**
 * How an ownership award's RATE is put into words.
 *
 * One implementation, deliberately: the payslip, the payroll card and the
 * role-earnings report each grew their own basis→label map, and they had
 * already drifted (only the payslip printed the rate at all, and it printed the
 * raw basis key). An employee checking their pay against three screens should
 * see the same sentence on all three.
 *
 * The awkward part this file hides: on a per-unit basis `basisAmountInr` holds
 * a COUNT, not rupees, and `fixedAmountInr` is a rate per unit rather than a
 * flat amount. Formatting either with a ₹ prefix would be a lie.
 */

import type { OwnershipBasis } from './types'

/**
 * How each basis is offered when CONFIGURING a program — the wording in the
 * picker, which names the shape of the rule rather than describing an award.
 *
 * Typed as a total Record so that widening `OwnershipBasis` is a compile error
 * here until the new basis has a name an owner can choose.
 */
export const BASIS_CHOICE_LABEL: Record<OwnershipBasis, string> = {
  billing: '% of billing',
  collected: '% of collections',
  profit: '% of profit',
  fixed: 'Fixed amount',
  entries: '₹ per cash-book entry',
}

/** Bases whose rule is a rupee rate per unit rather than a percentage. */
export const PER_UNIT_BASES: OwnershipBasis[] = ['entries']

/** The plural noun each basis measures, for "2% of collections". */
export const BASIS_NOUN: Record<string, string> = {
  billing: 'billing',
  collected: 'collections',
  profit: 'profit',
  entries: 'cash-book entries',
}

export interface RateShape {
  basis: string
  /** Rupees on a money basis; a UNIT COUNT on a per-unit basis. */
  basisAmountInr: number
  percent: number | null
  fixedAmountInr?: number | null
}

const inr = (n: number) => Math.round(n).toLocaleString('en-IN')

/**
 * "142 entries × ₹5" · "2% of collections" · "fixed amount".
 *
 * Never returns an empty string: a payslip line with a rupee amount and no
 * explanation beside it is exactly the thing this is for.
 */
export function rateLabel(a: RateShape): string {
  if (a.basis === 'entries') {
    const units = Math.round(a.basisAmountInr)
    const noun = units === 1 ? 'entry' : 'entries'
    return `${inr(units)} ${noun} × ₹${inr(a.fixedAmountInr ?? 0)}`
  }
  if (a.percent != null) return `${a.percent}% of ${BASIS_NOUN[a.basis] ?? a.basis}`
  if (a.basis === 'fixed') return 'fixed amount'
  if (a.basis === 'mixed') return 'mixed rates'
  return a.basis
}
