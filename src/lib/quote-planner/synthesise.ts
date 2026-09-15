import type { Contribution, ContributionGroup, Employee, Parameter, Tool } from '@/types'
import type { TaskContributionInput } from '@/lib/calculations/commission'
import type { PlanLine, RatingPlan, ShareOverride } from './types'

/**
 * Turning "I want CQID001 on 60% of the design" into something the real
 * commission engine can score.
 *
 * THE WHOLE POINT: `calculateCommission` is the only thing in this codebase
 * allowed to decide what an employee earns. It takes plain arrays — employees,
 * groups, parameters, tools, contributions — and knows nothing about where
 * they came from. So a quote does not need a second formula; it needs
 * SYNTHETIC INPUTS that make the real formula produce the split the planner
 * is asking about.
 *
 * WHY THE SHARES COME OUT AS TYPED: within a group the engine computes
 *
 *     empGroupScore = Σ (empValue[p] / paramTotal[p]) × weight[p]
 *     normalised    = empGroupScore / Σ weight[p]      ← active params only
 *
 * Feed it `empValue[p] = sharePct` and every term becomes `share / 100`, so an
 * employee given 60 on one parameter scores 0.6 of that group — whatever the
 * parameter's weight is, because the weight appears in both the numerator and
 * the denominator. Across groups the same cancellation happens again. That is
 * why the planner can present these as plain percentages and be telling the
 * truth.
 *
 * A parameter nobody is given a share on stays at zero total, and the engine
 * drops it from the active set — so an unused sub-parameter cannot dilute
 * anybody, exactly as it cannot on a real task.
 */

/** A plan's employees, with the rating the plan wants to model them at. */
export interface PlannedEmployee {
  id: string
  cqid: string
  /** Their real rating, used when the plan does not override it. */
  performanceRating: number
}

export interface SynthesiseInput {
  line: PlanLine
  /** Quote value for this line, per month, already in INR. */
  monthlyInr: number
  employees: PlannedEmployee[]
  groups: ContributionGroup[]
  parameters: Parameter[]
  /** Tools the service uses. `used` decides whether the cut is taken. */
  tools: { tool: Tool; used: boolean }[]
  shares: ShareOverride[]
  ratings: RatingPlan
}

/**
 * A synthetic employee row. Only the fields the engine reads are real; the
 * rest are filled to satisfy the type and are never looked at.
 *
 * `name` is set to the CQID on purpose. The engine copies it into
 * `EmployeeEarning.employeeName`, and a real name reaching that field is one
 * careless render away from breaking the privacy gate. Putting the CQID here
 * means there is no name to leak.
 */
function syntheticEmployee(e: PlannedEmployee, ratingPct: number): Employee {
  return {
    id: e.id,
    cqid: e.cqid,
    name: e.cqid,
    email: '',
    role: 'employee',
    performance_rating: ratingPct,
    salary_type: 'pure_commission',
    base_salary: 0,
    hourly_rate: 0,
    is_active: true,
    created_at: '',
    updated_at: '',
  }
}

/** The rating a plan models this employee at: the override, else their own. */
export function plannedRating(employee: PlannedEmployee, ratings: RatingPlan): number {
  const override = ratings[employee.id]
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.max(0, Math.min(100, override))
  }
  const own = Number(employee.performanceRating)
  return Number.isFinite(own) ? Math.max(0, Math.min(100, own)) : 100
}

/**
 * Build the engine's input for one line.
 *
 * `taskId` is a synthetic id. Nothing is written anywhere — the engine only
 * uses it to label its own result.
 */
export function toCommissionInput(input: SynthesiseInput): TaskContributionInput {
  const { line, monthlyInr, employees, groups, parameters, tools, shares, ratings } = input

  const mine = shares.filter(s => s.lineId === line.id && s.sharePct > 0)

  const contributions: Contribution[] = mine.map((s, i) => ({
    id: 'plan-c-' + i,
    task_id: 'plan-' + line.id,
    employee_id: s.employeeId,
    parameter_id: s.parameterId,
    value: s.sharePct,
    locked: false,
    created_at: '',
    updated_at: '',
  }))

  return {
    taskId: 'plan-' + line.id,
    billingAmountINR: monthlyInr,
    serviceCommissionPct: line.commissionPct,
    employees: employees.map(e => syntheticEmployee(e, plannedRating(e, ratings))),
    groups,
    parameters,
    toolsUsed: tools,
    contributions,
  }
}

/**
 * Which employees a line actually involves.
 *
 * Only those given a share. Handing the engine every employee in the company
 * would be harmless arithmetically — a zero contribution scores zero — but it
 * would fill the panel with rows of ₹0 and bury the three people the quote is
 * really about.
 */
export function employeesOnLine(lineId: string, shares: ShareOverride[]): string[] {
  const seen = new Set<string>()
  for (const s of shares) {
    if (s.lineId === lineId && s.sharePct > 0) seen.add(s.employeeId)
  }
  return [...seen]
}
