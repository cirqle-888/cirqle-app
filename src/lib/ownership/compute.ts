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

import type {
  OwnershipAward, OwnershipBasis, OwnershipPeriod, OwnershipProgram, OwnershipRule,
  PeriodAggregates,
} from './types'

const r2 = (n: number) => Math.round(n * 100) / 100

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
    if (!rule.employeeId) continue
    overridden.add(rule.employeeId)
    out.push({ employeeId: rule.employeeId, rule })
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

/** Pick the measured amount for a basis. `fixed` measures nothing. */
export function basisAmount(basis: OwnershipBasis, agg: PeriodAggregates): number {
  switch (basis) {
    case 'billing':   return agg.billingInr
    case 'collected': return agg.collectedInr
    case 'profit':    return agg.profitInr
    case 'fixed':     return 0
  }
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
  const measured = basisAmount(program.basis, agg)
  return participants.map(({ employeeId, rule }) => ({
    programId: program.id,
    ruleId: rule.id,
    employeeId,
    period,
    basis: program.basis,
    // The TRUE measured amount is snapshotted even when negative, so a loss
    // month is auditable rather than invisible behind a ₹0 payout.
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
      ruleSource: rule.employeeId ? 'employee' : 'designation',
      ruleLabel: rule.label,
      measuredInr: r2(measured),
      clampedAtZero: measured < 0,
    },
  }))
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
