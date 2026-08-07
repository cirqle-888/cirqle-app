/**
 * Ownership Platform — shared types.
 *
 * Three concepts, deliberately separated so that every reward the business
 * will ever want is a CONFIGURATION rather than a new subsystem:
 *
 *   Program — what, when, and from what money  (basis × period × scope)
 *   Rule    — who, and how much                (employee or designation, % or ₹)
 *   Award   — the computed result, snapshotted (immutable, auditable)
 *
 * `programType` is a display label only. Behaviour comes entirely from
 * basis + periodType + scope, which is why "quarterly incentive", "festival
 * bonus" and "revenue share" need no code of their own.
 */

/** Where the money is measured from. */
export type OwnershipBasis =
  /** Task billing in the period (accrual — matches how commissions are earned). */
  | 'billing'
  /** Cash actually received in the period (revenue inflows in the journal). */
  | 'collected'
  /** Company profit after contribution earnings, salaries and expenses. */
  | 'profit'
  /** No measurement — a flat amount per participant (bonuses). */
  | 'fixed'

export type OwnershipPeriodType = 'monthly' | 'quarterly' | 'yearly' | 'one_time'

/** Which slice of revenue the program measures. */
export type OwnershipScopeKind =
  | 'company' | 'client' | 'service' | 'service_category' | 'org_unit'

export interface OwnershipProgram {
  id: string
  name: string
  programType: string
  basis: OwnershipBasis
  periodType: OwnershipPeriodType
  scopeKind: OwnershipScopeKind
  scopeId: string | null
  /** one_time programs only. */
  periodStart: string | null
  periodEnd: string | null
  effectiveFrom: string
  effectiveTo: string | null
  isActive: boolean
}

export interface OwnershipRule {
  id: string
  programId: string
  /** Exactly one of these is set. */
  employeeId: string | null
  designationId: string | null
  /** Exactly one of these is set. */
  percent: number | null
  fixedAmountInr: number | null
  /** The participant's "hat" for this program — Team Lead, Ops Manager, HR. */
  label: string | null
  effectiveFrom: string
  effectiveTo: string | null
  isActive: boolean
}

/** A concrete date range a program pays for. */
export interface OwnershipPeriod {
  start: string   // YYYY-MM-DD inclusive
  end: string     // YYYY-MM-DD inclusive
  /** Payroll month this period books into — its END month. */
  bookedMonth: number
  bookedYear: number
  label: string   // 'July 2026', 'Q3 2026', '2026'
}

export interface OwnershipAward {
  programId: string
  ruleId: string
  employeeId: string
  period: OwnershipPeriod
  basis: OwnershipBasis
  basisAmountInr: number
  percent: number | null
  fixedAmountInr: number | null
  earnedInr: number
  breakdown: Record<string, unknown>
}

/** Everything a period's awards are computed from. */
export interface PeriodAggregates {
  /** Scoped billing for the period, per program scope key. */
  billingInr: number
  collectedInr: number
  profitInr: number
}
