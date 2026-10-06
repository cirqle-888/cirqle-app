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
  clients_handled: 'Client handling (₹ per client or % of their billing)',
  planned: 'Content planning (₹ per task or % of its billing)',
  activities: '₹ per activity (pick the kinds)',
}

/** Bases whose rule can ONLY be a rupee rate per unit — a % of a count means nothing. */
export const PER_UNIT_BASES: OwnershipBasis[] = ['entries', 'activities']

/** Per-person bases: unit nouns, and what a % rule is a share of. */
export const PER_PERSON_UNIT: Record<string, { one: string; many: string; money?: string }> = {
  entries: { one: 'entry', many: 'entries' },
  activities: { one: 'activity', many: 'activities' },
  clients_handled: { one: 'client', many: 'clients', money: 'their clients’ billing' },
  planned: { one: 'planned task', many: 'planned tasks', money: 'billing they planned' },
}

/** The plural noun each basis measures, for "2% of collections". */
export const BASIS_NOUN: Record<string, string> = {
  billing: 'billing',
  collected: 'collections',
  profit: 'profit',
  entries: 'cash-book entries',
  clients_handled: 'their clients’ billing',
  planned: 'billing they planned',
  activities: 'activities',
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
  const unit = PER_PERSON_UNIT[a.basis]
  if (unit && a.percent == null) {
    const units = Math.round(a.basisAmountInr)
    return `${inr(units)} ${units === 1 ? unit.one : unit.many} × ₹${inr(a.fixedAmountInr ?? 0)}`
  }
  if (unit?.money && a.percent != null) return `${a.percent}% of ${unit.money} (₹${inr(a.basisAmountInr)})`
  if (a.percent != null) return `${a.percent}% of ${BASIS_NOUN[a.basis] ?? a.basis}`
  if (a.basis === 'fixed') return 'fixed amount'
  if (a.basis === 'mixed') return 'mixed rates'
  return a.basis
}
