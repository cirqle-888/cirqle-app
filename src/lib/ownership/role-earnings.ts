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

const r2 = (n: number) => Math.round(n * 100) / 100

/** One stored award, flattened to what a report needs. */
export interface AwardLine {
  employeeId: string
  /** The hat this award paid for — the rule's label. Null when unlabeled. */
  label: string | null
  programName: string
  basis: string
  percent: number | null
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
  /** 'billing' | 'collected' | 'profit' | 'fixed', or 'mixed' across programs. */
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
      const bases = new Set(hatAwards.map(a => a.basis))
      return {
        role,
        totalInr: r2(hatAwards.reduce((s, a) => s + a.earnedInr, 0)),
        programNames: [...new Set(hatAwards.map(a => a.programName))].sort(),
        percent: percents.size === 1 ? [...percents][0] : null,
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
