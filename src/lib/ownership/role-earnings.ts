/**
 * Earnings by role — the reporting lens over stored ownership awards.
 *
 * One person can wear several hats (Accounts, HR, CEO Direct) and be paid for
 * each separately: every ownership RULE carries a label, and every award
 * snapshot carries that label in its `breakdown`. Payroll then sums the lot
 * into a single `ownership_earned` figure — correct for paying, useless for
 * asking "what did the Accounts hat earn this quarter".
 *
 * This module answers that question. Pure grouping over award rows: no IO, no
 * recomputation. The numbers are the snapshots payroll already paid from, so
 * this report cannot disagree with a payslip.
 */

import { monthPeriod } from './periods'

// Canonical money rounding — a local Math.round(n * 100) / 100 disagrees at
// the .xx5 midpoints (1.005 -> 1.00 instead of 1.01) and would drift from
// the finance engines. See currency.ts round2.
import { round2 as r2 } from '@/lib/calculations/currency'

/** One stored award, flattened to what a report needs. */
export interface AwardLine {
  employeeId: string
  /** The hat this award paid for — the rule's label. Null when unlabeled. */
  label: string | null
  programName: string
  basis: string
  percent: number | null
  /** Flat rupees, or ₹ per unit on a per-unit basis. */
  fixedAmountInr: number | null
  /** Rupees on a money basis; a UNIT COUNT on a per-unit basis. */
  basisAmountInr: number
  earnedInr: number
  /** Payroll month the award booked into — a quarter books into its END month. */
  bookedMonth: number
  bookedYear: number
}

/**
 * The display key for an award: its hat, falling back to the program name.
 *
 * The fallback keeps unlabeled rules visible rather than pooling them under a
 * nameless "—" bucket. A hat that happens to share a program's name merges
 * with it, which is the reading a human would expect from two identical names.
 */
export function roleKeyOf(a: { label: string | null; programName: string }): string {
  const hat = a.label?.trim()
  return hat ? hat : a.programName
}

export interface RoleMonth { month: number; year: number; label: string; totalInr: number }
export interface RolePerson { employeeId: string; totalInr: number; programNames: string[] }

export interface RoleGroup {
  role: string
  /** False when every award here fell back to the program name (no rule label). */
  labelled: boolean
  totalInr: number
  awardCount: number
  people: RolePerson[]
  months: RoleMonth[]
}

export interface PersonHat {
  role: string
  totalInr: number
  programNames: string[]
  /** The rate, when every award in this hat shares one; null when mixed. */
  percent: number | null
  /** Per-unit rate, when every award in this hat shares one; null when mixed. */
  fixedAmountInr: number | null
  /** Units/rupees measured across the hat — summed, since the rate is shared. */
  basisAmountInr: number
  /** 'billing' | 'collected' | 'profit' | 'fixed' | 'entries', or 'mixed'. */
  basis: string
}

export interface PersonGroup {
  employeeId: string
  totalInr: number
  hats: PersonHat[]
}

/** Group awards by hat — "what did Accounts earn, and who earned it". */
export function groupByRole(awards: AwardLine[]): RoleGroup[] {
  const byRole = new Map<string, AwardLine[]>()
  for (const a of awards) {
    const key = roleKeyOf(a)
    const list = byRole.get(key)
    if (list) list.push(a)
    else byRole.set(key, [a])
  }

  const groups: RoleGroup[] = []
  for (const [role, list] of byRole) {
    const people = new Map<string, { totalInr: number; programNames: Set<string> }>()
    const months = new Map<string, { month: number; year: number; totalInr: number }>()

    for (const a of list) {
      const p = people.get(a.employeeId) ?? { totalInr: 0, programNames: new Set<string>() }
      p.totalInr += a.earnedInr
      p.programNames.add(a.programName)
      people.set(a.employeeId, p)

      const key = `${a.bookedYear}-${a.bookedMonth}`
      const m = months.get(key) ?? { month: a.bookedMonth, year: a.bookedYear, totalInr: 0 }
      m.totalInr += a.earnedInr
      months.set(key, m)
    }

    groups.push({
      role,
      labelled: list.some(a => !!a.label?.trim()),
      totalInr: r2(list.reduce((s, a) => s + a.earnedInr, 0)),
      awardCount: list.length,
      people: [...people.entries()]
        .map(([employeeId, v]) => ({
          employeeId,
          totalInr: r2(v.totalInr),
          programNames: [...v.programNames].sort(),
        }))
        .sort((a, b) => b.totalInr - a.totalInr || a.employeeId.localeCompare(b.employeeId)),
      months: [...months.values()]
        .map(m => ({ ...m, totalInr: r2(m.totalInr), label: monthPeriod(m.year, m.month).label }))
        .sort((a, b) => b.year - a.year || b.month - a.month),
    })
  }

  return groups.sort((a, b) => b.totalInr - a.totalInr || a.role.localeCompare(b.role))
}

/** Group awards by person — "I wear four hats; what did each pay me". */
export function groupByPerson(awards: AwardLine[]): PersonGroup[] {
  const byPerson = new Map<string, AwardLine[]>()
  for (const a of awards) {
    const list = byPerson.get(a.employeeId)
    if (list) list.push(a)
    else byPerson.set(a.employeeId, [a])
  }

  const groups: PersonGroup[] = []
  for (const [employeeId, list] of byPerson) {
    const byHat = new Map<string, AwardLine[]>()
    for (const a of list) {
      const key = roleKeyOf(a)
      const hat = byHat.get(key)
      if (hat) hat.push(a)
      else byHat.set(key, [a])
    }

    const hats: PersonHat[] = [...byHat.entries()].map(([role, hatAwards]) => {
      // A hat paid by two programs at different rates has no single rate to
      // show — saying "2%" there would be a lie, so it shows nothing.
      const percents = new Set(hatAwards.map(a => a.percent))
      const rates = new Set(hatAwards.map(a => a.fixedAmountInr))
      const bases = new Set(hatAwards.map(a => a.basis))
      return {
        role,
        totalInr: r2(hatAwards.reduce((s, a) => s + a.earnedInr, 0)),
        programNames: [...new Set(hatAwards.map(a => a.programName))].sort(),
        percent: percents.size === 1 ? [...percents][0] : null,
        fixedAmountInr: rates.size === 1 ? [...rates][0] : null,
        basisAmountInr: r2(hatAwards.reduce((s, a) => s + a.basisAmountInr, 0)),
        basis: bases.size === 1 ? [...bases][0] : 'mixed',
      }
    }).sort((a, b) => b.totalInr - a.totalInr || a.role.localeCompare(b.role))

    groups.push({
      employeeId,
      totalInr: r2(list.reduce((s, a) => s + a.earnedInr, 0)),
      hats,
    })
  }

  return groups.sort((a, b) => b.totalInr - a.totalInr || a.employeeId.localeCompare(b.employeeId))
}

export function totalEarned(awards: AwardLine[]): number {
  return r2(awards.reduce((s, a) => s + a.earnedInr, 0))
}

// ── The report's period ─────────────────────────────────────────────────────

export const ROLE_RANGES = [
  { key: 'this', label: 'This month' },
  { key: 'last', label: 'Last month' },
  { key: '3m', label: '3 months' },
  { key: 'ytd', label: 'This year' },
  { key: '12m', label: '12 months' },
] as const
export type RoleRangeKey = (typeof ROLE_RANGES)[number]['key']

export interface RoleWindow {
  /** Payroll months the report covers, oldest first. */
  months: { month: number; year: number }[]
  /** 'month' when one month was picked with the arrows, else the range key. */
  key: RoleRangeKey | 'month'
  /** "September 2026", "Last 3 months · Aug–Oct 2026". */
  label: string
  /** The month the ‹ › arrows step from (the single month, or the range's end). */
  anchor: { month: number; year: number }
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Which payroll months to show. `month=YYYY-MM` (the arrows) wins; otherwise a
 * range key; the old `months=N` links still work. Never reaches past today.
 */
export function resolveRoleWindow(
  params: { month?: string; range?: string; months?: string },
  today: Date,
): RoleWindow {
  const cur = { month: today.getMonth() + 1, year: today.getFullYear() }
  const back = (n: number) => {
    const d = new Date(cur.year, cur.month - 1 - n, 1)
    return { month: d.getMonth() + 1, year: d.getFullYear() }
  }
  const lastN = (n: number) => Array.from({ length: n }, (_, i) => back(n - 1 - i))
  const span = (ms: { month: number; year: number }[]) => {
    const a = ms[0], b = ms[ms.length - 1]
    return a.year === b.year
      ? `${MON[a.month - 1]}–${MON[b.month - 1]} ${b.year}`
      : `${MON[a.month - 1]} ${a.year} – ${MON[b.month - 1]} ${b.year}`
  }

  const m = /^(\d{4})-(\d{2})$/.exec(params.month ?? '')
  if (m) {
    const year = Number(m[1]), month = Number(m[2])
    const future = year > cur.year || (year === cur.year && month > cur.month)
    if (month >= 1 && month <= 12 && !future) {
      return { months: [{ month, year }], key: 'month', label: monthPeriod(year, month).label, anchor: { month, year } }
    }
  }

  const legacy = Number(params.months)
  const range = (params.range ?? (legacy ? '' : '12m')) as RoleRangeKey
  switch (range) {
    case 'this': return { months: [cur], key: 'this', label: `This month · ${monthPeriod(cur.year, cur.month).label}`, anchor: cur }
    case 'last': {
      const p = back(1)
      return { months: [p], key: 'last', label: `Last month · ${monthPeriod(p.year, p.month).label}`, anchor: p }
    }
    case '3m': { const ms = lastN(3); return { months: ms, key: '3m', label: `Last 3 months · ${span(ms)}`, anchor: cur } }
    case 'ytd': { const ms = lastN(cur.month); return { months: ms, key: 'ytd', label: `This year · ${span(ms)}`, anchor: cur } }
    default: {
      const n = legacy ? Math.min(24, Math.max(1, legacy)) : 12
      const ms = lastN(n)
      return { months: ms, key: '12m', label: `Last ${n} months · ${span(ms)}`, anchor: cur }
    }
  }
}

/** The month before / after, for the ‹ › arrows; null when it would be in the future. */
export function stepMonth(at: { month: number; year: number }, by: -1 | 1, today: Date): string | null {
  const d = new Date(at.year, at.month - 1 + by, 1)
  if (d > new Date(today.getFullYear(), today.getMonth(), 1)) return null
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
