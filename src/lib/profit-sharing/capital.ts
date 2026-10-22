/**
 * Capital-days and the Capital Share (design §7.3–7.4).
 *
 *   balance_i(d)   = Σ approved movements with effective date ≤ d (in − out) × weight
 *   capital-days_i = Σ over each day of the period of balance_i(d)
 *   entitlement_i  = Capital Share × capital-days_i ÷ Σ capital-days, to the paisa
 *
 * Only approved movements count. Money invested in the last week of a period
 * earns one week's share, not the whole period's.
 */

import { round2 } from '@/lib/calculations/currency'
import { splitByWeight } from '@/lib/reports/ownership-allocation'
import type { CapitalMovement } from './types'

const DAY = 86_400_000
const toTime = (d: string) => Date.parse(`${d}T00:00:00Z`)

/** Inclusive day count between two YYYY-MM-DD dates. */
export function daysInclusive(start: string, end: string): number {
  return Math.round((toTime(end) - toTime(start)) / DAY) + 1
}

export function addDays(date: string, n: number): string {
  return new Date(toTime(date) + n * DAY).toISOString().slice(0, 10)
}

const signed = (m: CapitalMovement) => (m.direction === 'in' ? m.amountInr : -m.amountInr)

/** Unweighted approved balance at the end of a day. */
export function balanceOn(movements: CapitalMovement[], memberId: string, date: string): number {
  return round2(movements
    .filter(m => m.memberId === memberId && m.status === 'approved' && m.effectiveOn <= date)
    .reduce((s, m) => s + signed(m), 0))
}

/** Weighted capital-days of one member over [start, end]. A negative weighted balance counts as 0. */
export function capitalDays(movements: CapitalMovement[], memberId: string, start: string, end: string): number {
  const mine = movements
    .filter(m => m.memberId === memberId && m.status === 'approved' && m.effectiveOn <= end)
    .sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn))
  let balance = 0
  for (const m of mine) if (m.effectiveOn <= start) balance += signed(m) * m.weight
  const changes = [...new Set(mine.filter(m => m.effectiveOn > start).map(m => m.effectiveOn))]
  let total = 0
  let from = start
  for (const day of changes) {
    total += Math.max(0, balance) * daysInclusive(from, addDays(day, -1))
    for (const m of mine) if (m.effectiveOn === day) balance += signed(m) * m.weight
    from = day
  }
  total += Math.max(0, balance) * daysInclusive(from, end)
  return Math.round(total * 10_000) / 10_000
}

export interface EntitlementPreview {
  memberId: string
  capitalDays: number
  share: number
  amountInr: number
  openingBalanceInr: number
  closingBalanceInr: number
}

export interface CapitalAllocation {
  entitlements: EntitlementPreview[]
  totalCapitalDays: number
  /** Capital Share nobody could receive (no eligible capital in the period). */
  unallocatedInr: number
}

export function allocateCapitalShare(
  capitalShareInr: number,
  movements: CapitalMovement[],
  memberIds: string[],
  start: string,
  end: string,
): CapitalAllocation {
  const rows = memberIds.map(id => ({ id, days: capitalDays(movements, id, start, end) }))
  const total = rows.reduce((s, r) => s + r.days, 0)
  if (total <= 0 || capitalShareInr <= 0) {
    return {
      entitlements: [],
      totalCapitalDays: round2(total),
      unallocatedInr: total <= 0 ? round2(Math.max(0, capitalShareInr)) : 0,
    }
  }
  const eligible = rows.filter(r => r.days > 0)
  const amounts = splitByWeight(capitalShareInr, eligible.map(r => r.days))
  return {
    entitlements: eligible.map((r, i) => ({
      memberId: r.id,
      capitalDays: r.days,
      share: r.days / total,
      amountInr: amounts[i],
      openingBalanceInr: balanceOn(movements, r.id, addDays(start, -1)),
      closingBalanceInr: balanceOn(movements, r.id, end),
    })),
    totalCapitalDays: total,
    unallocatedInr: 0,
  }
}
