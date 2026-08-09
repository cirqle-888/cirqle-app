/**
 * What-If Planner — pure simulation engine.
 *
 * A Scenario is a plain-JSON set of hypothetical changes (rating overrides,
 * commission/price changes, salary increments, billing growth, draft
 * agreements). Simulation = transform the same raw inputs the Contribution
 * Analysis report uses, then re-run `buildAnalysisRows` — the exact engine
 * behind the live report — so simulated numbers can never drift from what
 * would really happen. Nothing here touches the database.
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
import type { CommissionAgreement, AgreementType } from '@/lib/calculations/agreements'
import { earningFor } from '@/lib/ownership/compute'
import type { OwnershipRule } from '@/lib/ownership/types'

const r2 = (n: number) => Math.round(n * 100) / 100

// ─── Scenario shape (plain JSON — ready for future DB persistence) ────────────

export interface DraftAgreement {
  /** local id, e.g. crypto.randomUUID() — becomes the CommissionAgreement id in simulation */
  id: string
  employee_id: string
  client_id: string | null
  service_id: string | null
  agreement_type: AgreementType
  agreement_value: number
  /** when set, the real agreement with this id is EXCLUDED from simulation (drafting a modification) */
  replaces_agreement_id?: string | null
}

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
  draftAgreements: DraftAgreement[]
  /** roles you might delegate — simulation-only, never applied */
  draftOwnershipRules: DraftOwnershipRule[]
}

export function emptyScenario(id: string, name: string): Scenario {
  return {
    id, name,
    ratingOverrides: {},
    commissionOverrides: {},
    priceOverrides: {},
    salaryIncrements: {},
    billingGrowthPct: 0,
    draftAgreements: [],
    draftOwnershipRules: [],
  }
}

/** True when the scenario contains no changes at all. */
export function isScenarioEmpty(s: Scenario): boolean {
  return Object.keys(s.ratingOverrides).length === 0
    && Object.keys(s.commissionOverrides).length === 0
    && Object.keys(s.priceOverrides).length === 0
    && Object.keys(s.salaryIncrements).length === 0
    && s.billingGrowthPct === 0
    && s.draftAgreements.length === 0
    && (s.draftOwnershipRules?.length ?? 0) === 0
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
  agreements: CommissionAgreement[]
  /**
   * agreementItemId → work_commission_pct. Without it, retainer-linked tasks
   * simulate at the pricing-matrix rate while the live report uses the
   * agreement's override — the two would disagree on identical inputs, which
   * is exactly what this module promises cannot happen.
   */
  itemCommissionPct?: Record<string, number | null>
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
  let agreements = raw.agreements
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
    //
    // Deliberately does NOT scale work_value_inr, so retainer-covered tasks
    // hold their pool basis under both levers. Charging a client more does not
    // raise what the work is internally worth, and "business grows 10%" means
    // more retainer clients or more posts, not a richer per-post value. Scaling
    // it would quietly hand the team a raise nobody agreed to. Change the
    // agreement's Work Value to model that instead.
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

    // Draft agreements: exclude any real agreement a draft replaces, then add
    // the drafts as real-shaped agreements effective over all baseline dates.
    // The genuine matchAgreement specificity/tie-break rules then apply — an
    // honest preview of exactly what creating the agreement would do.
    if (s.draftAgreements.length > 0) {
      const replaced = new Set(s.draftAgreements.map(d => d.replaces_agreement_id).filter(Boolean))
      agreements = agreements
        .filter(a => !replaced.has(a.id))
        .concat(s.draftAgreements.map(d => ({
          id: d.id,
          employee_id: d.employee_id,
          client_id: d.client_id,
          service_id: d.service_id,
          agreement_type: d.agreement_type,
          agreement_value: d.agreement_value,
          currency: 'INR',
          effective_from: '1900-01-01', // covers every baseline task date
          effective_to: null,
          is_active: true,
        })))
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
    agreements,
    new Map(Object.entries(raw.itemCommissionPct || {})),
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
  /** base + increment + simulated earnings — before advances/deductions */
  projectedSalary: number | null
  currentSalary: number | null         // base + current earnings
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
  /** Σ (base + increment) + commission — before advances/deductions */
  payrollCost: MetricDelta
  /** profit ÷ payroll cost (0 when payroll cost is 0) */
  roi: MetricDelta
  /** What the scenario's draft roles would cost. Current is always 0 — a draft
   *  role does not exist yet, so there is nothing to compare it against. */
  ownershipCost: MetricDelta
  /** Profit once the draft roles are paid. Excludes any LIVE ownership
   *  programs, which the planner does not model. */
  profitAfterOwnership: MetricDelta
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
): ScenarioComparison {
  const current = computeSummary(currentRows)
  const simulated = computeSummary(simulatedRows)

  const perEmployee: EmployeeImpact[] = employees.map(e => {
    const curEarn = sumEarnings(currentRows, e.id)
    const simEarn = sumEarnings(simulatedRows, e.id)
    const base = baseSalaries?.[e.id]
    const increment = base != null ? resolveIncrement(base, scenario.salaryIncrements[e.id]) : 0
    return {
      id: e.id,
      name: e.name,
      cqid: e.cqid,
      earnings: mkDelta(curEarn, simEarn),
      baseSalary: base ?? null,
      increment,
      currentSalary: base != null ? r2(base + curEarn) : null,
      projectedSalary: base != null ? r2(base + increment + simEarn) : null,
    }
  })

  // Payroll cost = Σ base(+increment) over employees with visible salary + commission cost.
  // Without salary visibility it degrades to commission-only (labeled in the UI).
  let curPayroll = current.totalEarnings
  let simPayroll = simulated.totalEarnings
  if (baseSalaries) {
    for (const e of perEmployee) {
      if (e.baseSalary != null) {
        curPayroll += e.baseSalary
        simPayroll += e.baseSalary + e.increment
      }
    }
  }

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
    payrollCost: mkDelta(curPayroll, simPayroll),
    roi,
    ownershipCost: mkDelta(0, ownership.totalInr),
    profitAfterOwnership: mkDelta(current.totalProfit, r2(simulated.totalProfit - ownership.totalInr)),
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
): number {
  const s = computeSummary(rows)
  switch (goal.kind) {
    case 'profit_margin_pct':
      return s.totalBilling > 0 ? s.totalProfit / s.totalBilling * 100 : 0
    case 'monthly_profit':
      return s.totalProfit
    case 'payroll_pct_of_revenue': {
      let payroll = s.totalEarnings
      if (baseSalaries) for (const v of Object.values(baseSalaries)) payroll += v
      return s.totalBilling > 0 ? payroll / s.totalBilling * 100 : 0
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
): GoalSeekResult {
  let [lo, hi] = leverBounds(lever)
  const evalAt = (v: number) =>
    goalValue(simulateScenario(raw, scenarioWithLever(base, lever, v, raw)), goal, baseSalaries)

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
