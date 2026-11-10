/**
 * What-If Planner — pure simulation engine.
 *
 * A Scenario is a plain-JSON set of hypothetical changes (rating overrides,
 * commission/price changes, salary increments, billing growth). Simulation =
 * transform the same raw inputs the Contribution Analysis report uses, then
 * re-run `buildAnalysisRows` — the exact engine behind the live report — so
 * simulated numbers can never drift from what would really happen. Nothing
 * here touches the database.
 *
 * Every lever is one independent input transform, so future planning modules
 * (hiring impact, discount impact, goal-based planning…) plug in as new
 * transforms without redesigning the engine.
 */

import {
  buildAnalysisRows, computeSummary, groupRows,
  type AnalysisRow, type RawTask, type RawScore, type RawPricing,
  type EmployeeColumn, type Summary,
} from './contribution-analysis'
import { earningFor } from '@/lib/ownership/compute'
import type { OwnershipRule } from '@/lib/ownership/types'

// Canonical money rounding — a local Math.round(n * 100) / 100 disagrees at
// the .xx5 midpoints (1.005 -> 1.00 instead of 1.01). See currency.ts round2.
import { round2 as r2 } from '@/lib/calculations/currency'

// ─── Scenario shape (plain JSON — ready for future DB persistence) ────────────

export interface SalaryIncrement {
  mode: 'amount' | 'pct'
  value: number
}

/**
 * A role you are considering paying for — "what would delegating Accounts cost".
 *
 * Deliberately NOT a real ownership rule: no employee, no dates, no scope. The
 * question this lever answers is what a hat costs the business, which is the
 * same answer whoever ends up wearing it. Creating the real program stays in
 * Settings → Ownership; nothing here is ever applied.
 *
 * `collected` is absent by design — the planner simulates task billing and has
 * no cash-receipt data to take a percentage of, and quietly substituting
 * billing would understate a role in a month with poor collections.
 */
export interface DraftOwnershipRule {
  /** local id, e.g. crypto.randomUUID() */
  id: string
  /** The hat: "Accounts", "HR", "Operations". */
  label: string
  basis: 'billing' | 'profit' | 'fixed'
  percent: number | null
  fixedAmountInr: number | null
}

export interface Scenario {
  id: string
  name: string
  /** employeeId → new performance rating (0–100) */
  ratingOverrides: Record<string, number>
  /** `${clientId}|${serviceId}` → new commission % */
  commissionOverrides: Record<string, number>
  /** `${clientId}|${serviceId}` → { oldPrice, newPrice } — scales that pairing's billings by newPrice/oldPrice */
  priceOverrides: Record<string, { oldPrice: number; newPrice: number }>
  /** employeeId → base-salary increment */
  salaryIncrements: Record<string, SalaryIncrement>
  /** global "what if business grows/shrinks N%" — simulation-only, never applied */
  billingGrowthPct: number
  /** roles you might delegate — simulation-only, never applied */
  draftOwnershipRules: DraftOwnershipRule[]
  /**
   * Live ownership rule id → a different rate: the new % on a percentage rule,
   * the new ₹ on a flat or per-unit rule. Simulation-only — the real rate is
   * changed in Settings → Ownership.
   */
  ownershipRateOverrides?: Record<string, number>
}

export function emptyScenario(id: string, name: string): Scenario {
  return {
    id, name,
    ratingOverrides: {},
    commissionOverrides: {},
    priceOverrides: {},
    salaryIncrements: {},
    billingGrowthPct: 0,
    draftOwnershipRules: [],
    ownershipRateOverrides: {},
  }
}

/** True when the scenario contains no changes at all. */
export function isScenarioEmpty(s: Scenario): boolean {
  return Object.keys(s.ratingOverrides).length === 0
    && Object.keys(s.commissionOverrides).length === 0
    && Object.keys(s.priceOverrides).length === 0
    && Object.keys(s.salaryIncrements).length === 0
    && s.billingGrowthPct === 0
    && (s.draftOwnershipRules?.length ?? 0) === 0
    && Object.keys(s.ownershipRateOverrides ?? {}).length === 0
}

// ─── Ownership: what a delegated role would cost ──────────────────────────────

export interface OwnershipCostLine {
  ruleId: string
  label: string
  basis: DraftOwnershipRule['basis']
  /** The amount the percentage was taken of (0 for a fixed award). */
  measuredInr: number
  costInr: number
}

export interface OwnershipCost {
  lines: OwnershipCostLine[]
  totalInr: number
}

/**
 * What a set of draft roles would cost against a simulated period.
 *
 * Shares `earningFor` with the live ownership engine, so a role modelled here
 * and the same role configured for real produce the same number from the same
 * inputs — the planner can't flatter a decision the payroll run will then
 * contradict.
 *
 * `profitInr` is the planner's profit (billing − contribution earnings). It is
 * NOT the finance engine's profit, which also subtracts base salaries and
 * company expenses, so a profit-basis role costs MORE here than it will in
 * production. Callers must label it as such rather than presenting it as the
 * company's profit share.
 */
export function simulateOwnership(
  rules: DraftOwnershipRule[],
  totals: { billingInr: number; profitInr: number },
): OwnershipCost {
  const lines = (rules ?? []).map(rule => {
    const measured =
      rule.basis === 'billing' ? totals.billingInr
      : rule.basis === 'profit' ? totals.profitInr
      : 0
    return {
      ruleId: rule.id,
      label: rule.label,
      basis: rule.basis,
      measuredInr: r2(measured),
      // The engine's own earning rule: fixed wins, percentages clamp at zero,
      // and a percentage of a fixed-basis award earns nothing.
      costInr: earningFor(rule.basis, measured, {
        percent: rule.percent, fixedAmountInr: rule.fixedAmountInr,
      } as OwnershipRule),
    }
  })
  return { lines, totalInr: r2(lines.reduce((s, l) => s + l.costInr, 0)) }
}

// ─── The rest of payroll: live ownership, bonuses, adjustments ─────────────────

/**
 * One payroll amount the task engine does not produce, booked in a month.
 *
 *   ownership  — a stored award from a LIVE ownership program
 *   bonus      — the payslip's bonus
 *   adjustment — back-pay settled on the payslip (payroll.adjustment_earned)
 *
 * Advances and other deductions are deliberately absent: they are money the
 * employee pays back, not a cost to the business.
 */
export interface PayrollExtraLine {
  employeeId: string
  /** YYYY-MM the amount booked into. */
  month: string
  kind: 'ownership' | 'bonus' | 'adjustment'
  /** ownership only — decides how the award moves with the scenario. */
  basis?: string
  /** ownership only — the program, for showing where it came from. */
  programName?: string
  /** ownership only — the rule that paid it, so its rate can be changed. */
  ruleId?: string
  /** ownership only — the rule's hat ("Operation Manager"). */
  ruleLabel?: string | null
  /** ownership only — the rate the award was paid at: a % … */
  percent?: number | null
  /** … or ₹ (flat, or per unit on a per-unit basis). */
  fixedAmountInr?: number | null
  amountInr: number
}

/** Ownership bases measured as a share of task billing — they move with revenue. */
const BILLING_LIKE_BASES = new Set(['billing', 'referrals', 'clients_handled', 'planned'])

/**
 * What a payroll extra would be under the scenario.
 *
 * A live program's award is re-scaled by what it is measured from: a share of
 * billing moves with simulated revenue, a share of profit with simulated
 * profit. Everything the planner cannot simulate — collections (cash, not
 * billing), counts of entries or activities, fixed bonuses, back-pay — stays
 * at what was actually paid. Proportional scaling is exact for a company-wide
 * % of billing and an approximation for a program narrowed to one client.
 */
export function simulateExtra(
  line: PayrollExtraLine,
  current: { billingInr: number; profitInr: number },
  simulated: { billingInr: number; profitInr: number },
  rateOverrides: Record<string, number> = {},
): number {
  if (line.kind !== 'ownership' || !line.basis) return line.amountInr
  const amount = line.amountInr * rateFactor(line, rateOverrides)
  if (BILLING_LIKE_BASES.has(line.basis)) {
    return current.billingInr > 0 ? r2(amount * Math.max(0, simulated.billingInr) / current.billingInr) : r2(amount)
  }
  if (line.basis === 'profit') {
    return current.profitInr > 0 ? r2(amount * Math.max(0, simulated.profitInr) / current.profitInr) : r2(amount)
  }
  return r2(amount)
}

/** Ownership bases whose rate can be changed in the planner (referrals: each job sets its own %). */
export const RATE_CHANGEABLE = (basis: string | undefined) => !!basis && basis !== 'referrals'

/**
 * How much a changed rate moves an award. Every ownership award is linear in
 * its rate — a % of an amount, ₹ × units, or a flat ₹ — so 4% instead of 3%
 * pays 4/3 of what was paid. An award paid at a rate of 0 has nothing to scale
 * from, so it stays as it was.
 */
function rateFactor(line: PayrollExtraLine, overrides: Record<string, number>): number {
  if (!line.ruleId || !RATE_CHANGEABLE(line.basis)) return 1
  const next = overrides[line.ruleId]
  if (next == null || !Number.isFinite(next)) return 1
  const was = line.percent != null ? line.percent : line.fixedAmountInr
  if (was == null || was <= 0) return 1
  return Math.max(0, next) / was
}

/** Per-employee totals of the extras, now and under the scenario. */
function extrasByEmployee(
  extras: PayrollExtraLine[],
  current: { billingInr: number; profitInr: number },
  simulated: { billingInr: number; profitInr: number },
  rateOverrides: Record<string, number> = {},
) {
  const out = new Map<string, { ownershipNow: number; ownershipSim: number; other: number }>()
  for (const l of extras) {
    const e = out.get(l.employeeId) ?? { ownershipNow: 0, ownershipSim: 0, other: 0 }
    if (l.kind === 'ownership') {
      e.ownershipNow += l.amountInr
      e.ownershipSim += simulateExtra(l, current, simulated, rateOverrides)
    } else {
      e.other += l.amountInr
    }
    out.set(l.employeeId, e)
  }
  return out
}

/** One live ownership rule as the rate lever shows it. */
export interface LiveOwnershipRule {
  ruleId: string
  programName: string
  ruleLabel: string | null
  basis: string
  /** The rate in force: a % (percent set) or ₹ (fixedAmountInr set). */
  percent: number | null
  fixedAmountInr: number | null
  employeeIds: string[]
  /** What it paid across the baseline. */
  paidInr: number
}

/**
 * The live rules behind the baseline's ownership awards, one per rule. The
 * rate shown is the latest one paid — a rule changed mid-period still scales
 * each month by its own rate in simulateExtra.
 */
export function liveOwnershipRules(extras: PayrollExtraLine[]): LiveOwnershipRule[] {
  const out = new Map<string, LiveOwnershipRule & { month: string }>()
  for (const l of extras) {
    if (l.kind !== 'ownership' || !l.ruleId || !RATE_CHANGEABLE(l.basis)) continue
    const r = out.get(l.ruleId) ?? {
      ruleId: l.ruleId, programName: l.programName ?? 'Ownership reward', ruleLabel: l.ruleLabel ?? null,
      basis: l.basis!, percent: l.percent ?? null, fixedAmountInr: l.fixedAmountInr ?? null,
      employeeIds: [], paidInr: 0, month: l.month,
    }
    if (l.month > r.month) { r.month = l.month; r.percent = l.percent ?? null; r.fixedAmountInr = l.fixedAmountInr ?? null }
    if (!r.employeeIds.includes(l.employeeId)) r.employeeIds.push(l.employeeId)
    r.paidInr = r2(r.paidInr + l.amountInr)
    out.set(l.ruleId, r)
  }
  return [...out.values()]
    .map((r): LiveOwnershipRule => ({
      ruleId: r.ruleId, programName: r.programName, ruleLabel: r.ruleLabel, basis: r.basis,
      percent: r.percent, fixedAmountInr: r.fixedAmountInr, employeeIds: r.employeeIds, paidInr: r.paidInr,
    }))
    .sort((a, b) => a.programName.localeCompare(b.programName) || (a.ruleLabel ?? '').localeCompare(b.ruleLabel ?? ''))
}

/** How the comparison counts payroll beyond task commission. */
export interface PayrollContext {
  /** Months in the baseline — base salary is paid once per month. Default 1. */
  months?: number
  /** Live ownership awards, bonuses and adjustments booked in those months. */
  extras?: PayrollExtraLine[]
}

// ─── Raw inputs (serializable — passed from the server page to the client) ────

export interface WhatIfRawInputs {
  tasks: RawTask[]
  scores: RawScore[]
  pricing: RawPricing[]
  clients: { id: string; name: string }[]
  services: { id: string; name: string }[]
  /** employeeId → performance_rating */
  empRating: Record<string, number>
  /** taskId → Σ tool fixed_percentage */
  toolPctByTask: Record<string, number>
}

// ─── Simulation: transform inputs → re-run the real engine ────────────────────

/**
 * Baseline rows: the untouched engine output for the given inputs.
 * (Actual/FX apportioning is intentionally omitted — the planner deals in
 * expected profit; the Contribution Analysis report remains the place for
 * actual/FX detail.)
 */
export function baselineRows(raw: WhatIfRawInputs): AnalysisRow[] {
  return runEngine(raw, null)
}

/** Scenario rows: same engine, transformed inputs. */
export function simulateScenario(raw: WhatIfRawInputs, s: Scenario): AnalysisRow[] {
  return runEngine(raw, s)
}

function runEngine(raw: WhatIfRawInputs, s: Scenario | null): AnalysisRow[] {
  let tasks = raw.tasks
  let pricing = raw.pricing
  const empRating = new Map(Object.entries(raw.empRating))
  const toolPctByTask = new Map(Object.entries(raw.toolPctByTask))

  if (s) {
    // Performance rating overrides.
    for (const [empId, rating] of Object.entries(s.ratingOverrides)) {
      empRating.set(empId, rating)
    }

    // Commission % overrides per client|service.
    if (Object.keys(s.commissionOverrides).length > 0) {
      const overridden = new Set(Object.keys(s.commissionOverrides))
      pricing = pricing
        .filter(p => !overridden.has(`${p.client_id}|${p.service_id}`))
        .concat(Object.entries(s.commissionOverrides).map(([key, pct]) => {
          const [client_id, service_id] = key.split('|')
          return { client_id, service_id, commission_percentage: pct }
        }))
    }

    // Billing scaling: global growth % plus per-pairing price ratios.
    const growth = 1 + (s.billingGrowthPct || 0) / 100
    const priceKeys = Object.keys(s.priceOverrides)
    if (growth !== 1 || priceKeys.length > 0) {
      tasks = tasks.map(t => {
        let factor = growth
        const key = `${t.client_id}|${t.service_id}`
        const price = s.priceOverrides[key]
        if (price && price.oldPrice > 0) factor *= price.newPrice / price.oldPrice
        if (factor === 1) return t
        return {
          ...t,
          billing_amount: r2((t.billing_amount || 0) * factor),
          billing_amount_inr: r2((t.billing_amount_inr || 0) * factor),
        }
      })
    }
  }

  return buildAnalysisRows(
    tasks,
    raw.scores,
    pricing,
    new Map(raw.clients.map(c => [c.id, c.name])),
    new Map(raw.services.map(sv => [sv.id, sv.name])),
    new Map(),  // actual/FX omitted — expected-profit planner
    50,
    empRating,
    toolPctByTask,
    100,
  )
}

// ─── Comparison ────────────────────────────────────────────────────────────────

export interface MetricDelta {
  current: number
  simulated: number
  delta: number
}

export interface EmployeeImpact {
  id: string
  name: string
  cqid: string
  earnings: MetricDelta
  baseSalary: number | null            // null when viewer lacks payroll.view_amounts
  increment: number                    // resolved ₹ increment (0 when none)
  /** Live ownership programs — what was paid, and what the scenario would pay. */
  ownership: MetricDelta
  /** Bonus + back-pay adjustments actually paid — the scenario does not move them. */
  bonusAdjustments: number
  /** (base + increment) × months + simulated earnings + ownership + bonus — before advances/deductions */
  projectedSalary: number | null
  currentSalary: number | null         // base × months + current earnings + ownership + bonus
}

export interface GroupImpact {
  key: string
  label: string
  billing: MetricDelta
  earnings: MetricDelta
  profit: MetricDelta
  marginPct: MetricDelta
}

export interface ScenarioComparison {
  summary: { current: Summary; simulated: Summary }
  revenue: MetricDelta
  commissionCost: MetricDelta
  profit: MetricDelta
  marginPct: MetricDelta
  /** Base salaries (+ increments) for the period: Σ base × months. Zero without salary access. */
  baseSalaryCost: MetricDelta
  /** Live ownership programs (stored awards, re-scaled by the scenario). */
  liveOwnership: MetricDelta
  /** Bonuses + back-pay adjustments paid in the period — unchanged by the scenario. */
  bonusAdjustments: MetricDelta
  /** Everything payroll pays: base + commission + ownership + bonus + adjustments — before advances/deductions */
  payrollCost: MetricDelta
  /** profit ÷ payroll cost (0 when payroll cost is 0) */
  roi: MetricDelta
  /** What the scenario's draft roles would cost. Current is always 0 — a draft
   *  role does not exist yet, so there is nothing to compare it against. */
  ownershipCost: MetricDelta
  /** Profit once live ownership and the draft roles are paid. */
  profitAfterOwnership: MetricDelta
  /** Revenue − everything payroll pays − draft roles: what is left for expenses. */
  profitAfterPayroll: MetricDelta
  /** Per-role cost, for showing which hat is expensive. */
  ownershipLines: OwnershipCostLine[]
  perEmployee: EmployeeImpact[]
  perClient: GroupImpact[]
  perService: GroupImpact[]
}

function sumEarnings(rows: AnalysisRow[], empId: string): number {
  let sum = 0
  for (const r of rows) sum += r.emp[empId]?.earn ?? 0
  return r2(sum)
}

export function resolveIncrement(base: number, inc: SalaryIncrement | undefined): number {
  if (!inc) return 0
  return inc.mode === 'pct' ? r2(base * inc.value / 100) : r2(inc.value)
}

function groupImpacts(currentRows: AnalysisRow[], simulatedRows: AnalysisRow[], key: 'client' | 'service'): GroupImpact[] {
  const cur = groupRows(currentRows, key)
  const sim = groupRows(simulatedRows, key)
  const simByKey = new Map(sim.map(g => [g.key, g]))
  return cur.map(g => {
    const sg = simByKey.get(g.key)
    const c = g.summary
    const sSum = sg?.summary ?? g.summary
    return {
      key: g.key,
      label: g.label,
      billing: mkDelta(c.totalBilling, sSum.totalBilling),
      earnings: mkDelta(c.totalEarnings, sSum.totalEarnings),
      profit: mkDelta(c.totalProfit, sSum.totalProfit),
      marginPct: mkDelta(
        c.totalBilling > 0 ? r2(c.totalProfit / c.totalBilling * 100) : 0,
        sSum.totalBilling > 0 ? r2(sSum.totalProfit / sSum.totalBilling * 100) : 0,
      ),
    }
  })
}

function mkDelta(current: number, simulated: number): MetricDelta {
  return { current: r2(current), simulated: r2(simulated), delta: r2(simulated - current) }
}

export function compareScenario(
  currentRows: AnalysisRow[],
  simulatedRows: AnalysisRow[],
  employees: EmployeeColumn[],
  /** employeeId → base_salary; missing/undefined = viewer can't see salaries */
  baseSalaries: Record<string, number> | null,
  scenario: Scenario,
  payroll: PayrollContext = {},
): ScenarioComparison {
  const current = computeSummary(currentRows)
  const simulated = computeSummary(simulatedRows)
  const months = Math.max(1, payroll.months ?? 1)
  const curTotals = { billingInr: current.totalBilling, profitInr: current.totalProfit }
  const simTotals = { billingInr: simulated.totalBilling, profitInr: simulated.totalProfit }
  const extras = extrasByEmployee(payroll.extras ?? [], curTotals, simTotals, scenario.ownershipRateOverrides ?? {})

  const perEmployee: EmployeeImpact[] = employees.map(e => {
    const curEarn = sumEarnings(currentRows, e.id)
    const simEarn = sumEarnings(simulatedRows, e.id)
    const base = baseSalaries?.[e.id]
    const increment = base != null ? resolveIncrement(base, scenario.salaryIncrements[e.id]) : 0
    const x = extras.get(e.id) ?? { ownershipNow: 0, ownershipSim: 0, other: 0 }
    return {
      id: e.id,
      name: e.name,
      cqid: e.cqid,
      earnings: mkDelta(curEarn, simEarn),
      baseSalary: base ?? null,
      increment,
      ownership: mkDelta(x.ownershipNow, x.ownershipSim),
      bonusAdjustments: r2(x.other),
      currentSalary: base != null ? r2(base * months + curEarn + x.ownershipNow + x.other) : null,
      projectedSalary: base != null ? r2((base + increment) * months + simEarn + x.ownershipSim + x.other) : null,
    }
  })

  // Base salary is a MONTHLY amount, so a multi-month baseline pays it once
  // per month — counting it once against several months of commission made
  // payroll look cheaper the longer the period.
  let curBase = 0
  let simBase = 0
  if (baseSalaries) {
    for (const e of perEmployee) {
      if (e.baseSalary != null) {
        curBase += e.baseSalary * months
        simBase += (e.baseSalary + e.increment) * months
      }
    }
  }
  let curOwnership = 0, simOwnership = 0, bonusAdj = 0
  for (const x of extras.values()) {
    curOwnership += x.ownershipNow
    simOwnership += x.ownershipSim
    bonusAdj += x.other
  }

  // Payroll cost = base + commission + live ownership + bonus/adjustments.
  // Without salary visibility the page passes no salaries and no extras, so it
  // degrades to commission-only (labelled in the UI).
  const curPayroll = current.totalEarnings + curBase + curOwnership + bonusAdj
  const simPayroll = simulated.totalEarnings + simBase + simOwnership + bonusAdj

  const marginPct = mkDelta(
    current.totalBilling > 0 ? r2(current.totalProfit / current.totalBilling * 100) : 0,
    simulated.totalBilling > 0 ? r2(simulated.totalProfit / simulated.totalBilling * 100) : 0,
  )
  const roi = mkDelta(
    curPayroll > 0 ? r2(current.totalProfit / curPayroll * 100) : 0,
    simPayroll > 0 ? r2(simulated.totalProfit / simPayroll * 100) : 0,
  )

  // Draft roles are paid OUT of profit, so they are computed from the
  // simulated profit and then subtracted from it — never fed back in, which
  // would make profit depend on itself (the engine's circularity rule).
  const ownership = simulateOwnership(scenario.draftOwnershipRules ?? [], {
    billingInr: simulated.totalBilling,
    profitInr: simulated.totalProfit,
  })

  return {
    summary: { current, simulated },
    revenue: mkDelta(current.totalBilling, simulated.totalBilling),
    commissionCost: mkDelta(current.totalEarnings, simulated.totalEarnings),
    profit: mkDelta(current.totalProfit, simulated.totalProfit),
    marginPct,
    baseSalaryCost: mkDelta(curBase, simBase),
    liveOwnership: mkDelta(curOwnership, simOwnership),
    bonusAdjustments: mkDelta(bonusAdj, bonusAdj),
    payrollCost: mkDelta(curPayroll, simPayroll),
    roi,
    ownershipCost: mkDelta(0, ownership.totalInr),
    profitAfterOwnership: mkDelta(
      current.totalProfit - curOwnership,
      r2(simulated.totalProfit - simOwnership - ownership.totalInr),
    ),
    profitAfterPayroll: mkDelta(
      current.totalBilling - curPayroll,
      r2(simulated.totalBilling - simPayroll - ownership.totalInr),
    ),
    ownershipLines: ownership.lines,
    perEmployee,
    perClient: groupImpacts(currentRows, simulatedRows, 'client'),
    perService: groupImpacts(currentRows, simulatedRows, 'service'),
  }
}

// ─── Goal Seek (single-lever binary search) ────────────────────────────────────

export type GoalMetric =
  | { kind: 'profit_margin_pct'; target: number }
  | { kind: 'monthly_profit'; target: number }
  | { kind: 'payroll_pct_of_revenue'; target: number }       // payroll ≤ target %
  | { kind: 'employee_earnings'; employeeId: string; target: number }

export type GoalLever =
  | { kind: 'global_commission_pct' }                         // every pairing's commission %
  | { kind: 'billing_growth_pct' }
  | { kind: 'client_service_price'; key: string; oldPrice: number }
  | { kind: 'employee_rating'; employeeId: string }

export interface GoalSeekResult {
  /** the lever value that hits the goal, or null when unreachable within bounds */
  value: number | null
  achieved: number
  iterations: number
}

/** Metric extraction for the solver — mirrors compareScenario's aggregates. */
function goalValue(
  rows: AnalysisRow[],
  goal: GoalMetric,
  baseSalaries: Record<string, number> | null,
  payroll: PayrollContext & { baseline?: Summary; rateOverrides?: Record<string, number> } = {},
): number {
  const s = computeSummary(rows)
  switch (goal.kind) {
    case 'profit_margin_pct':
      return s.totalBilling > 0 ? s.totalProfit / s.totalBilling * 100 : 0
    case 'monthly_profit':
      return s.totalProfit
    case 'payroll_pct_of_revenue': {
      const months = Math.max(1, payroll.months ?? 1)
      let cost = s.totalEarnings
      if (baseSalaries) for (const v of Object.values(baseSalaries)) cost += v * months
      // Live ownership, bonuses and adjustments, moved by this candidate's
      // revenue and profit exactly as compareScenario moves them.
      const now = payroll.baseline
        ? { billingInr: payroll.baseline.totalBilling, profitInr: payroll.baseline.totalProfit }
        : { billingInr: s.totalBilling, profitInr: s.totalProfit }
      for (const l of payroll.extras ?? []) {
        cost += simulateExtra(l, now, { billingInr: s.totalBilling, profitInr: s.totalProfit }, payroll.rateOverrides)
      }
      return s.totalBilling > 0 ? cost / s.totalBilling * 100 : 0
    }
    case 'employee_earnings':
      return sumEarnings(rows, goal.employeeId)
  }
}

function scenarioWithLever(base: Scenario, lever: GoalLever, value: number, raw: WhatIfRawInputs): Scenario {
  const s: Scenario = JSON.parse(JSON.stringify(base))
  switch (lever.kind) {
    case 'global_commission_pct': {
      // Override every pairing present in the data to the same %.
      const keys = new Set<string>()
      for (const t of raw.tasks) if (t.client_id && t.service_id) keys.add(`${t.client_id}|${t.service_id}`)
      for (const k of keys) s.commissionOverrides[k] = value
      break
    }
    case 'billing_growth_pct':
      s.billingGrowthPct = value
      break
    case 'client_service_price':
      s.priceOverrides[lever.key] = { oldPrice: lever.oldPrice, newPrice: value }
      break
    case 'employee_rating':
      s.ratingOverrides[lever.employeeId] = value
      break
  }
  return s
}

/** Solver bounds per lever type. */
function leverBounds(lever: GoalLever): [number, number] {
  switch (lever.kind) {
    case 'global_commission_pct': return [0, 100]
    case 'billing_growth_pct':    return [-90, 500]
    case 'client_service_price':  return [0.01, 10_000_000]
    case 'employee_rating':       return [0, 100]
  }
}

/**
 * Binary-search the lever value whose simulated metric reaches the goal.
 * Works because every lever here is monotonic in every supported metric.
 */
export function goalSeek(
  raw: WhatIfRawInputs,
  base: Scenario,
  goal: GoalMetric,
  lever: GoalLever,
  baseSalaries: Record<string, number> | null,
  tolerance = 0.05,
  maxIterations = 60,
  payroll: PayrollContext = {},
): GoalSeekResult {
  let [lo, hi] = leverBounds(lever)
  const ctx = { ...payroll, baseline: computeSummary(baselineRows(raw)), rateOverrides: base.ownershipRateOverrides ?? {} }
  const evalAt = (v: number) =>
    goalValue(simulateScenario(raw, scenarioWithLever(base, lever, v, raw)), goal, baseSalaries, ctx)

  const atLo = evalAt(lo)
  const atHi = evalAt(hi)
  const increasing = atHi >= atLo
  // Unreachable within bounds → report the closest end.
  const target = goal.target
  const min = Math.min(atLo, atHi), max = Math.max(atLo, atHi)
  if (target < min - tolerance || target > max + tolerance) {
    return { value: null, achieved: target < min ? min : max, iterations: 2 }
  }

  let iterations = 2
  let mid = lo
  for (let i = 0; i < maxIterations; i++) {
    mid = (lo + hi) / 2
    const v = evalAt(mid)
    iterations++
    if (Math.abs(v - target) <= tolerance) {
      return { value: r2(mid), achieved: r2(v), iterations }
    }
    if ((v < target) === increasing) lo = mid
    else hi = mid
  }
  return { value: r2(mid), achieved: r2(evalAt(mid)), iterations }
}
