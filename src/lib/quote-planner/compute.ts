import type { ContributionGroup, Parameter, Tool } from '@/types'
import { calculateCommission } from '@/lib/calculations/commission'
import { round2 } from '@/lib/calculations/currency'
import { allocateOverhead } from '@/lib/finance/overhead'
import { employeesOnLine, plannedRating, toCommissionInput, type PlannedEmployee } from './synthesise'
import type {
  LineEarning, LineResult, PlanMargin, PlanResult, QuotePlan,
} from './types'

/**
 * What a quote does to everyone's numbers.
 *
 * Pure: no database, no Supabase, no `server-only`. Every reference list comes
 * in as an argument, which is what lets the whole thing be proved in vitest
 * rather than only in production.
 *
 * It re-implements nothing. The pool and the per-employee split are
 * `calculateCommission`; the apportionment is `allocateOverhead`; the rounding
 * is `round2`. This file's job is to decide WHAT to ask them, and to keep
 * measured figures apart from allocated ones on the way out.
 */

export interface PlanRefs {
  employees: PlannedEmployee[]
  groups: ContributionGroup[]
  parameters: Parameter[]
  /** Tools per service id. A service with no entry takes no tool cut. */
  toolsByService: Record<string, { tool: Tool; used: boolean }[]>
  /** INR per 1 unit of the plan's currency. 1 for INR. */
  rateToInr: number
  /**
   * Company-wide monthly base salaries and recurring expenses, in INR, used
   * ONLY when the plan asks for overheads. Apportioned by this deal's share of
   * revenue against `companyMonthlyBillingInr`.
   */
  overheads?: {
    monthlyBaseSalariesInr: number
    monthlyExpensesInr: number
    companyMonthlyBillingInr: number
  }
}

const pct = (part: number, whole: number): number =>
  whole === 0 ? 0 : round2((part / whole) * 100)

export function planQuote(plan: QuotePlan, refs: PlanRefs): PlanResult {
  const notes: string[] = []
  const rate = Number.isFinite(refs.rateToInr) && refs.rateToInr > 0 ? refs.rateToInr : 1
  const months = Math.max(0, Math.round(plan.termMonths))
  if (months === 0) notes.push('The term is zero months, so every total is zero.')

  const byEmployee = new Map<string, LineEarning>()
  const lines: LineResult[] = []

  for (const line of plan.lines) {
    const monthlyQuoted = round2(line.unitPrice * line.monthlyQuantity)
    const monthlyQuotedInr = round2(monthlyQuoted * rate)

    const involved = employeesOnLine(line.id, plan.shares)
    const employees = refs.employees.filter(e => involved.includes(e.id))

    let poolInr = 0
    let toolsInr = 0
    let remainingInr = 0
    const earnings: LineEarning[] = []

    if (employees.length === 0) {
      // No shares set: the pool is still real money leaving the quote, but
      // nobody is named yet. Say so rather than showing a margin that quietly
      // assumes the work is free.
      poolInr = round2(monthlyQuotedInr * (line.commissionPct / 100))
      remainingInr = poolInr
      notes.push('One line has no employee shares set, so its pool is shown but unassigned.')
    } else {
      const result = calculateCommission(toCommissionInput({
        line,
        monthlyInr: monthlyQuotedInr,
        employees,
        groups: refs.groups,
        parameters: refs.parameters,
        tools: refs.toolsByService[line.serviceId] ?? [],
        shares: plan.shares,
        ratings: plan.ratings,
      }))

      poolInr = round2(result.employeePool)
      toolsInr = round2(result.toolDeductions.reduce((s, d) => s + d.amount, 0))
      remainingInr = round2(result.remainingPool)

      for (const e of result.employeeEarnings) {
        const who = employees.find(x => x.id === e.employeeId)
        if (!who) continue
        const monthlyInr = round2(e.earnings)
        earnings.push({
          employeeId: e.employeeId,
          // CQID only — the name never travels. See types.ts.
          employeeCqid: who.cqid,
          scorePercentage: round2(e.scorePercentage),
          ratingPct: plannedRating(who, plan.ratings),
          monthlyInr,
          termInr: round2(monthlyInr * months),
        })
      }
    }

    const earnedInr = round2(earnings.reduce((s, e) => s + e.monthlyInr, 0))

    const matrixMonthly = line.matrixUnitPrice === null
      ? null
      : round2(line.matrixUnitPrice * line.monthlyQuantity * rate)

    lines.push({
      lineId: line.id,
      serviceId: line.serviceId,
      monthlyQuoted,
      monthlyQuotedInr,
      termQuotedInr: round2(monthlyQuotedInr * months),
      employeePoolInr: poolInr,
      toolDeductionsInr: toolsInr,
      remainingPoolInr: remainingInr,
      earnings,
      earnedInr,
      vsMatrixInr: matrixMonthly === null ? null : round2(monthlyQuotedInr - matrixMonthly),
    })

    for (const e of earnings) {
      const prev = byEmployee.get(e.employeeId)
      if (!prev) { byEmployee.set(e.employeeId, { ...e }); continue }
      prev.monthlyInr = round2(prev.monthlyInr + e.monthlyInr)
      prev.termInr = round2(prev.termInr + e.termInr)
      // A share is per line; summed across lines it stops meaning anything.
      prev.scorePercentage = 0
    }
  }

  const monthlyQuotedInr = round2(lines.reduce((s, l) => s + l.monthlyQuotedInr, 0))
  const termQuotedInr = round2(monthlyQuotedInr * months)
  const monthlyEarnedInr = round2(lines.reduce((s, l) => s + l.earnedInr, 0))

  return {
    currency: plan.currency,
    rateToInr: rate,
    termMonths: months,
    lines,
    earnings: [...byEmployee.values()].sort((a, b) => b.termInr - a.termInr),
    monthlyQuotedInr,
    termQuotedInr,
    monthlyQuoted: round2(monthlyQuotedInr / rate),
    termQuoted: round2(termQuotedInr / rate),
    margin: buildMargin({ plan, refs, months, monthlyQuotedInr, termQuotedInr, monthlyEarnedInr, notes }),
    notes: [...new Set(notes)],
  }
}

/**
 * The margin block.
 *
 * MEASURED, then ALLOCATED, never mixed. `dealMarginInr` is arithmetic on this
 * quote alone and is defensible to the paise. `allocatedSalariesInr` and
 * `allocatedExpensesInr` are this deal's *share* of company-wide numbers —
 * a modelling choice, not a measurement — so they live in their own fields and
 * `overheadsIncluded` says whether they mean anything at all.
 */
function buildMargin(i: {
  plan: QuotePlan
  refs: PlanRefs
  months: number
  monthlyQuotedInr: number
  termQuotedInr: number
  monthlyEarnedInr: number
  notes: string[]
}): PlanMargin {
  const { plan, refs, months, termQuotedInr, monthlyQuotedInr, monthlyEarnedInr } = i

  const earningsInr = round2(monthlyEarnedInr * months)

  const plannedCostsInr = round2(plan.costs.reduce((sum, c) => {
    const inr = c.currency === plan.currency ? c.amount * refs.rateToInr : c.amount
    return sum + (c.cadence === 'monthly' ? inr * months : inr)
  }, 0))

  const dealMarginInr = round2(termQuotedInr - earningsInr - plannedCostsInr)

  let allocatedSalariesInr = 0
  let allocatedExpensesInr = 0
  const wanted = plan.includeOverheads && refs.overheads
  if (wanted && refs.overheads) {
    const { monthlyBaseSalariesInr, monthlyExpensesInr, companyMonthlyBillingInr } = refs.overheads
    // This deal against everything else the company bills in a month. The
    // "rest" entity is what makes the share a share rather than the whole.
    const rest = Math.max(0, companyMonthlyBillingInr - monthlyQuotedInr)
    const entities = [
      { id: 'deal', billingInr: Math.max(0, monthlyQuotedInr) },
      { id: 'rest', billingInr: rest },
    ]
    const salaries = allocateOverhead(round2(monthlyBaseSalariesInr * months), entities)
    const expenses = allocateOverhead(round2(monthlyExpensesInr * months), entities)
    allocatedSalariesInr = round2(salaries.get('deal') ?? 0)
    allocatedExpensesInr = round2(expenses.get('deal') ?? 0)
    if (companyMonthlyBillingInr <= 0) {
      i.notes.push('No company billing figure was available, so overheads could not be apportioned.')
    }
  } else if (plan.includeOverheads) {
    i.notes.push('Overheads were requested but no company figures were supplied, so none are allocated.')
  }

  const operatingResultInr = round2(dealMarginInr - allocatedSalariesInr - allocatedExpensesInr)

  return {
    quotedInr: termQuotedInr,
    earningsInr,
    plannedCostsInr,
    dealMarginInr,
    dealMarginPct: pct(dealMarginInr, termQuotedInr),
    allocatedSalariesInr,
    allocatedExpensesInr,
    operatingResultInr,
    operatingResultPct: pct(operatingResultInr, termQuotedInr),
    overheadsIncluded: Boolean(wanted),
  }
}
