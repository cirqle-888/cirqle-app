/**
 * Cirqle HQ — the umbrella view of people and money across units (pure).
 *
 * Used by the Admin's HQ report (every unit, every person) and by each unit's
 * Team tab (that unit's team only; everyone else folded under the owner — see
 * ./confidential).
 */

import { splitByWeight } from '@/lib/reports/ownership-allocation'
import { round2 } from '@/lib/calculations/currency'
import type { EngineEntry, EntryKind } from './engine'
import type { PayrollParts } from './suggest'

export type UnitAmounts = { kind: 'units'; byUnit: Map<string, number> } | { kind: 'waiting' } | { kind: 'excluded' }

/** How many rupees of an entry land in each unit, as it is allocated now. */
export function unitAmounts(
  entry: Pick<EngineEntry, 'amountInr'>, kind: EntryKind | undefined, generalUnitIds: readonly string[],
): UnitAmounts {
  const amount = Math.abs(entry.amountInr)
  if (!kind || (kind.kind === 'none' && kind.how === 'untagged')) return { kind: 'waiting' }
  if (kind.kind === 'none') return { kind: 'excluded' }
  if (kind.kind === 'dept') return { kind: 'units', byUnit: new Map([[kind.departmentId, round2(amount)]]) }
  if (kind.kind === 'split') {
    const parts = splitByWeight(amount, kind.parts.map(p => p.share))
    return { kind: 'units', byUnit: new Map(kind.parts.map((p, i) => [p.unitId, parts[i]])) }
  }
  // General: equally between the units that carry general costs.
  if (!generalUnitIds.length) return { kind: 'excluded' }
  const parts = splitByWeight(amount, generalUnitIds.map(() => 1))
  return { kind: 'units', byUnit: new Map(generalUnitIds.map((u, i) => [u, parts[i]])) }
}

export interface PersonPay {
  employeeId: string
  cqid: string
  /** The units this person is on; empty = office / owner's own staff. */
  unitIds: string[]
  paid: number
  base: number
  extra: number
  contribution: number
  /** Contribution earnings by the unit the work was for. */
  contributionByUnit: Map<string, number>
  ownership: number
  /** Paid amounts allocated to each unit so far. */
  byUnit: Map<string, number>
  waiting: number
  excluded: number
  /** Payroll months these payments were for. */
  payMonths: string[]
}

export interface PayEntry {
  entry: Pick<EngineEntry, 'id' | 'amountInr' | 'type' | 'employeeId' | 'description'>
  kind: EntryKind | undefined
  /** The payroll this payment paid, when known. */
  pay?: { employeeId: string; parts: PayrollParts; payMonth: string }
}

/** Pay per person for a month's salary payments, with where it was allocated. */
export function payByPerson(
  entries: readonly PayEntry[],
  cqidOf: ReadonlyMap<string, string>,
  unitsOfEmployee: ReadonlyMap<string, readonly string[]>,
  generalUnitIds: readonly string[],
): PersonPay[] {
  const idOfCqid = new Map([...cqidOf].map(([id, c]) => [c.replace(/\D/g, ''), id]))
  const people = new Map<string, PersonPay>()
  for (const { entry, kind, pay } of entries) {
    if (entry.type !== 'outflow') continue
    const fromText = (entry.description ?? '').match(/CQID\s*-?\s*(\d{3})/i)?.[1]
    const employeeId = pay?.employeeId ?? entry.employeeId ?? (fromText ? idOfCqid.get(fromText) : undefined)
    if (!employeeId) continue
    let p = people.get(employeeId)
    if (!p) {
      p = {
        employeeId, cqid: cqidOf.get(employeeId) ?? 'Unknown', unitIds: [...(unitsOfEmployee.get(employeeId) ?? [])],
        paid: 0, base: 0, extra: 0, contribution: 0, contributionByUnit: new Map(), ownership: 0, byUnit: new Map(), waiting: 0, excluded: 0, payMonths: [],
      }
      people.set(employeeId, p)
    }
    const amount = Math.abs(entry.amountInr)
    p.paid = round2(p.paid + amount)
    if (pay) {
      p.base = round2(p.base + pay.parts.base)
      p.extra = round2(p.extra + pay.parts.extra)
      p.ownership = round2(p.ownership + pay.parts.ownership)
      p.contribution = round2(p.contribution + pay.parts.commissionUnplaced + [...pay.parts.commissionByUnit.values()].reduce((t, v) => t + v, 0))
      for (const [u, v] of pay.parts.commissionByUnit) p.contributionByUnit.set(u, round2((p.contributionByUnit.get(u) ?? 0) + v))
      if (!p.payMonths.includes(pay.payMonth)) p.payMonths.push(pay.payMonth)
    }
    const a = unitAmounts(entry, kind, generalUnitIds)
    if (a.kind === 'waiting') p.waiting = round2(p.waiting + amount)
    else if (a.kind === 'excluded') p.excluded = round2(p.excluded + amount)
    else for (const [u, v] of a.byUnit) p.byUnit.set(u, round2((p.byUnit.get(u) ?? 0) + v))
  }
  return [...people.values()].sort((a, b) => a.cqid.localeCompare(b.cqid))
}

export interface TeamPayRow {
  employeeId: string
  cqid: string
  role: 'lead' | 'member'
  sharePct: number | null
  /** Paid this month at all? */
  paid: boolean
  base: number
  /** Contribution earned on this unit's work only. */
  contributionHere: number
  ownership: number
  extra: number
  /** What this unit carries of their pay. */
  chargedHere: number
  /** Paid but not allocated to any unit yet. */
  waiting: number
}

export interface TeamPayView {
  team: TeamPayRow[]
  /** Everyone outside the team, as one figure under the owner — never who or how much each. */
  ownerTeamInr: number
}

/**
 * One unit's Team view: its own people's pay by part and what the unit
 * carries of it. Contribution earned in other units and each person's total
 * pay are left out (they would show other units' figures); everyone outside
 * the team folds into one owner's-team figure.
 */
export function unitTeamView(
  people: readonly PersonPay[],
  unit: { id: string; members: readonly { employeeId: string; cqid: string; role: 'lead' | 'member' }[]; partners: readonly { employeeId: string; sharePct: number }[] },
): TeamPayView {
  const byId = new Map(people.map(p => [p.employeeId, p]))
  const team = unit.members.map(m => {
    const p = byId.get(m.employeeId)
    return {
      employeeId: m.employeeId, cqid: m.cqid, role: m.role,
      sharePct: unit.partners.find(x => x.employeeId === m.employeeId)?.sharePct ?? null,
      paid: !!p,
      base: p?.base ?? 0,
      contributionHere: p?.contributionByUnit.get(unit.id) ?? 0,
      ownership: p?.ownership ?? 0,
      extra: p?.extra ?? 0,
      chargedHere: p?.byUnit.get(unit.id) ?? 0,
      waiting: p?.waiting ?? 0,
    }
  }).sort((a, b) => a.cqid.localeCompare(b.cqid))
  const onTeam = new Set(unit.members.map(m => m.employeeId))
  const ownerTeamInr = round2(people.filter(p => !onTeam.has(p.employeeId)).reduce((t, p) => t + (p.byUnit.get(unit.id) ?? 0), 0))
  return { team, ownerTeamInr }
}
