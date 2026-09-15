/**
 * Quoting a package, and seeing what it does to everyone's numbers.
 *
 * A quote is a hypothesis: "if this client pays ₹X a month for N of these,
 * for T months". The planner answers what that totals, what reaches staff,
 * what each of them earns at a given performance rating, and what is left.
 *
 * NOTHING HERE COMPUTES MONEY. These are the inputs and the shape of the
 * answer; the arithmetic belongs to the engines the app already trusts —
 * `calculateCommission` for the pool and the split, `allocateOverhead` for
 * apportionment, `round2`/`computeInr` for money and FX. A second commission
 * formula living here is precisely how two screens start disagreeing about
 * somebody's pay.
 */

import type { Currency } from '@/types'

/** How a planned cost recurs over the term. */
export type CostCadence = 'once' | 'monthly'

/** Where a plan is in its life. Mirrors how quotations already read. */
export type PlanStatus = 'draft' | 'sent' | 'won' | 'lost'

/**
 * One service on the quote: how many a month, at what price.
 *
 * `unitPrice` is what the CLIENT pays per unit, in `currency`. It defaults
 * from the client's pricing matrix (falling back to the service's default),
 * but a quote is exactly the moment somebody wants to charge something else,
 * so it is editable and the resolved default is kept alongside for contrast.
 */
export interface PlanLine {
  id: string
  serviceId: string
  /** Units per month. A one-off line is a term of 1 month, not a zero here. */
  monthlyQuantity: number
  unitPrice: number
  currency: Currency
  /**
   * What the matrix would have charged, for showing how far the quote sits
   * from the rack rate. Null when the client has no matrix row and the
   * service has no default.
   */
  matrixUnitPrice: number | null
  /**
   * Share of billing that becomes the employee pool. Defaults to the client's
   * `commission_percentage` for this service, and to 50 when there is no row —
   * the same fallback `calculateCommission`'s callers use.
   */
  commissionPct: number
  displayOrder: number
}

/**
 * One employee's intended share of one parameter, 0–100.
 *
 * This is the "adjust contribution group and parameters" lever. Shares within
 * a parameter are relative: the engine normalises them, so they need not sum
 * to exactly 100 — but the UI should keep them close, because a person
 * reading "60 / 30" expects 60% and 30%, not 67% and 33%.
 */
export interface ShareOverride {
  lineId: string
  employeeId: string
  parameterId: string
  sharePct: number
}

/** A cost the quote carries that no engine knows about — print, a freelancer. */
export interface PlannedCost {
  id: string
  label: string
  amount: number
  currency: Currency
  cadence: CostCadence
}

/** What performance rating to plan each employee at, 0–100. */
export type RatingPlan = Record<string, number>

export interface QuotePlan {
  id: string
  clientId: string | null
  name: string
  status: PlanStatus
  /** The currency the client is quoted in. INR is always shown alongside. */
  currency: Currency
  termMonths: number
  lines: PlanLine[]
  shares: ShareOverride[]
  ratings: RatingPlan
  costs: PlannedCost[]
  /** Whether the margin block apportions company overheads to this deal. */
  includeOverheads: boolean
  quotationId: string | null
  notes: string
}

/* ── The answer ─────────────────────────────────────────────────────────── */

/**
 * What one employee takes from one line, per month.
 *
 * CQID ONLY — never a name. Employee names are private and the build fails on
 * a rendered one (`npm run lint:privacy`, scripts/check-name-privacy.mjs), so
 * the name never enters this shape in the first place. `calculateCommission`
 * returns `employeeName`; it is dropped at the boundary in compute.ts.
 */
export interface LineEarning {
  employeeId: string
  employeeCqid: string
  /** Share of the remaining pool, 0–100, before the rating multiplier. */
  scorePercentage: number
  /** Rating this was planned at, 0–100. */
  ratingPct: number
  monthlyInr: number
  termInr: number
}

export interface LineResult {
  lineId: string
  serviceId: string
  /** Quote value in the plan's currency, per month. */
  monthlyQuoted: number
  monthlyQuotedInr: number
  termQuotedInr: number
  /** billing × commissionPct — what is available to staff before tools. */
  employeePoolInr: number
  toolDeductionsInr: number
  /** What the split actually distributes. */
  remainingPoolInr: number
  earnings: LineEarning[]
  /** Sum of `earnings[].monthlyInr`. Below remainingPool when ratings < 100. */
  earnedInr: number
  /** Positive when the quote beats the matrix, negative when it discounts. */
  vsMatrixInr: number | null
}

/**
 * MEASURED and ALLOCATED are separate fields, deliberately.
 *
 * The pool and the earnings are computed from this quote. The salary and
 * expense shares are an apportionment of company-wide numbers, and an
 * apportionment presented as a measurement is how a plausible figure becomes
 * an unchallengeable one. `department-pnl.ts` keeps the same discipline and
 * for the same reason.
 */
export interface PlanMargin {
  /** Measured: what the client pays over the term. */
  quotedInr: number
  /** Measured: what staff earn from it. */
  earningsInr: number
  /** Measured: costs typed into this plan. */
  plannedCostsInr: number
  /** Measured: quoted − earnings − planned costs. */
  dealMarginInr: number
  dealMarginPct: number
  /** Allocated: this deal's share of base salaries, or 0 when off. */
  allocatedSalariesInr: number
  /** Allocated: this deal's share of recurring expenses, or 0 when off. */
  allocatedExpensesInr: number
  /** dealMargin − allocations. Equals dealMargin when overheads are off. */
  operatingResultInr: number
  operatingResultPct: number
  /** True when the allocated figures are real rather than zeroed. */
  overheadsIncluded: boolean
}

export interface PlanResult {
  currency: Currency
  /** INR per 1 unit of `currency`. 1 when the quote is already in INR. */
  rateToInr: number
  termMonths: number
  lines: LineResult[]
  /** Per employee, summed across every line. */
  earnings: LineEarning[]
  monthlyQuotedInr: number
  termQuotedInr: number
  /** The same totals in the quote's own currency, for the client-facing number. */
  monthlyQuoted: number
  termQuoted: number
  margin: PlanMargin
  /** Anything the planner could not do, said plainly rather than silently. */
  notes: string[]
}
