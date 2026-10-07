/**
 * Ownership award computation — the pure core.
 *
 * No database, no dates beyond what it is handed: given the participants and
 * the money measured for a period, decide what each person earned. Keeping
 * this pure is what makes the money path testable without a live schema.
 *
 * TWO RULES THAT MATTER MOST:
 *
 *  1. An employee-specific rule REPLACES the designation rules that would
 *     otherwise apply to that person in the same program. Without this,
 *     "managers get 2%, but Asha gets 3%" would pay Asha 5%. Replacement is
 *     per-employee-per-program, so Asha's override in one program does not
 *     affect her participation in another.
 *
 *  2. Earnings clamp at zero. A loss month makes a profit-share award ₹0 —
 *     felt clearly — but never a negative payslip line. The true (negative)
 *     basis is preserved in the breakdown so the transparency is not lost;
 *     deducting losses from salaries is a legal and morale problem, not an
 *     accounting improvement.
 */

import { PER_PERSON_BASES, PER_PERSON_MONEY_BASES, ruleEmployees } from './types'
import type {
  OwnershipAward, OwnershipBasis, OwnershipPeriod, OwnershipProgram, OwnershipRule,
  PeriodAggregates,
} from './types'

// Canonical money rounding — a local Math.round(n * 100) / 100 disagrees at
// the .xx5 midpoints (1.005 -> 1.00 instead of 1.01) and would drift from
// the finance engines. See currency.ts round2.
import { round2 as r2 } from '@/lib/calculations/currency'

export interface Participant {
  employeeId: string
  rule: OwnershipRule
}

/**
 * Who participates in this program for this period, after override resolution.
 *
 * @param membersByDesignation designationId → employeeIds (active employees)
 */
export function resolveParticipants(
  rules: OwnershipRule[],
  membersByDesignation: Map<string, string[]>,
): Participant[] {
  const live = rules.filter(r => r.isActive)

  // Employee-specific rules win outright for the employees they name.
  const overridden = new Set<string>()
  const out: Participant[] = []
  for (const rule of live) {
    for (const employeeId of ruleEmployees(rule)) {
      overridden.add(employeeId)
      out.push({ employeeId, rule })
    }
  }

  for (const rule of live) {
    if (!rule.designationId) continue
    for (const employeeId of membersByDesignation.get(rule.designationId) ?? []) {
      if (overridden.has(employeeId)) continue      // an override already covers them
      out.push({ employeeId, rule })
    }
  }
  return out
}

/**
 * Pick the program-wide measured amount for a basis. `fixed` measures nothing,
 * and `entries` is measured per participant — see `measuredFor`.
 *
 * The switch is deliberately exhaustive with no `default`: widening
 * `OwnershipBasis` is then a compile error here until the new basis is handled.
 */
export function basisAmount(basis: OwnershipBasis, agg: PeriodAggregates): number {
  switch (basis) {
    case 'billing':   return agg.billingInr
    case 'collected': return agg.collectedInr
    case 'profit':    return agg.profitInr
    case 'fixed':     return 0
    case 'entries':   return 0     // per participant; see measuredFor
    case 'clients_handled':
    case 'planned':
    case 'activities': return 0    // per participant; see measuredFor
  }
}

/**
 * What THIS participant is measured on.
 *
 * Every money basis is one program-wide amount that each rule takes a share of,
 * so they ignore `employeeId`. A count basis measures each person separately —
 * two people on the same rule earn different amounts.
 */
export function measuredFor(
  basis: OwnershipBasis,
  agg: PeriodAggregates,
  employeeId: string,
  /** A per-person % rule is measured on the person's MONEY; a ₹ rule on their COUNT. */
  rule?: Pick<OwnershipRule, 'percent' | 'fixedAmountInr'>,
): number {
  if (PER_PERSON_BASES.includes(basis)) {
    if (rule && rule.fixedAmountInr == null && rule.percent != null) return agg.amountByEmployee?.[employeeId] ?? 0
    return agg.unitsByEmployee?.[employeeId] ?? 0
  }
  return basisAmount(basis, agg)
}

/**
 * What one participant earns.
 *
 * A percentage rule on a `fixed`-basis program earns nothing (there is nothing
 * to take a percentage of), and a fixed rule ignores the basis entirely — both
 * are configuration mistakes the UI prevents, handled here so the engine can
 * never produce a NaN.
 */
export function earningFor(
  basis: OwnershipBasis,
  measured: number,
  rule: OwnershipRule,
): number {
  // A per-unit basis reads `fixedAmountInr` as the RATE PER UNIT. This branch
  // must precede the flat-amount short-circuit below, or a ₹5-per-entry rule
  // would pay ₹5 once instead of ₹5 × the count.
  if (PER_PERSON_BASES.includes(basis)) {
    // ₹ rule: a rate per unit. % rule: a share of the person's own money
    // (measuredFor hands over the money for a % rule, the count for a ₹ rule).
    if (rule.fixedAmountInr != null) return r2(Math.max(0, rule.fixedAmountInr * Math.max(0, measured)))
    // A % of a COUNT means nothing — only bases that measure the person's money take one.
    if (rule.percent == null || !PER_PERSON_MONEY_BASES.includes(basis)) return 0
    return r2(Math.max(0, measured * (rule.percent / 100)))
  }
  if (rule.fixedAmountInr != null) return r2(Math.max(0, rule.fixedAmountInr))
  if (rule.percent == null || basis === 'fixed') return 0
  return r2(Math.max(0, measured * (rule.percent / 100)))
}

/** Compute every award for one program × one period. */
export function computeAwards(
  program: OwnershipProgram,
  participants: Participant[],
  agg: PeriodAggregates,
  period: OwnershipPeriod,
): OwnershipAward[] {
  // Measured INSIDE the map: a per-participant basis gives each person their
  // own number, and hoisting it would silently pay everyone the first one.
  return participants.map(({ employeeId, rule }) => {
    const measured = measuredFor(program.basis, agg, employeeId, rule)
    const perPerson = PER_PERSON_BASES.includes(program.basis)
    const perUnit = perPerson && rule.fixedAmountInr != null
    return {
      programId: program.id,
      ruleId: rule.id,
      employeeId,
      period,
      basis: program.basis,
      // The TRUE measured amount is snapshotted even when negative, so a loss
      // month is auditable rather than invisible behind a ₹0 payout. On a
      // per-unit basis this column holds a COUNT, not rupees.
      basisAmountInr: r2(measured),
      percent: rule.percent,
      fixedAmountInr: rule.fixedAmountInr,
      earnedInr: earningFor(program.basis, measured, rule),
      breakdown: {
        programName: program.name,
        programType: program.programType,
        basis: program.basis,
        periodLabel: period.label,
        periodStart: period.start,
        periodEnd: period.end,
        scopeKind: program.scopeKind,
        scopeId: program.scopeId,
        ruleSource: ruleEmployees(rule).length ? 'employee' : 'designation',
        ruleLabel: rule.label,
        measuredInr: r2(measured),
        clampedAtZero: measured < 0,
        // Per-unit awards are self-describing without a join back to the rule,
        // whose `fixed_amount_inr` means something different on every basis.
        ...(perUnit ? {
          unit: 'entry',
          unitPlural: 'entries',
          units: measured,
          ratePerUnitInr: rule.fixedAmountInr ?? 0,
          countedOn: 'created_at',
        } : {}),
        // Per-person: both numbers and the items behind them, so an award can
        // say exactly what it counted. (`unit*` above stays for old readers.)
        ...(perPerson ? {
          units: agg.unitsByEmployee?.[employeeId] ?? 0,
          personAmountInr: agg.amountByEmployee?.[employeeId] ?? 0,
          items: agg.itemsByEmployee?.[employeeId] ?? [],
          ...(program.activityKinds?.length ? { activityKinds: program.activityKinds } : {}),
        } : {}),
      },
    }
  })
}

/**
 * Total percentage of company profit committed across active profit programs.
 *
 * Surfaced in the UI as a warning: nothing stops an owner from configuring
 * rules that promise 130% of profit, and the first time anyone notices would
 * otherwise be payday.
 */
export function totalProfitSharePercent(
  programs: OwnershipProgram[],
  rules: OwnershipRule[],
  membersByDesignation: Map<string, string[]>,
): number {
  let total = 0
  for (const p of programs) {
    if (!p.isActive || p.basis !== 'profit') continue
    const participants = resolveParticipants(
      rules.filter(r => r.programId === p.id),
      membersByDesignation,
    )
    for (const { rule } of participants) total += rule.percent ?? 0
  }
  return r2(total)
}
