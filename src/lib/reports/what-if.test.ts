/**
 * Unit tests for the What-If Planner simulation engine.
 *
 * Run with:  npx vitest run src/lib/reports/what-if.test.ts
 *
 * Each lever is checked against hand-computed figures produced by the same
 * formulas the live commission engine uses:
 *   pool = billing_inr × commission% / 100
 *   remainingPool = pool × (1 − toolPct/100)
 *   earn = remainingPool × score%/100 × rating/100     (contribution source)
 */
import { describe, it, expect } from 'vitest'
import {
  emptyScenario, isScenarioEmpty, baselineRows, simulateScenario,
  compareScenario, goalSeek, resolveIncrement,
  type WhatIfRawInputs,
} from './what-if'
import type { EmployeeColumn } from './contribution-analysis'

const EMPLOYEES: EmployeeColumn[] = [
  { id: 'e1', name: 'Alice', cqid: 'CQID001' },
  { id: 'e2', name: 'Bob', cqid: 'CQID002' },
]

/**
 * Fixture:
 *  t1 — client A × service S1, billing ₹10,000, commission 50% → pool 5,000.
 *       Alice score 60 @ rating 70 → 5000×0.6×0.7 = 2,100
 *       Bob   score 40 @ rating 100 → 5000×0.4×1.0 = 2,000
 *  t2 — client B × service S1, billing ₹20,000, commission 40% → pool 8,000.
 *       Alice score 100 @ rating 70 → 8000×1.0×0.7 = 5,600
 */
function fixture(): WhatIfRawInputs {
  return {
    tasks: [
      { id: 't1', task_number: 1, title: 'T1', task_date: '2026-06-10', status: 'done', currency: 'INR', billing_amount: 10000, billing_amount_inr: 10000, client_id: 'A', service_id: 'S1' },
      { id: 't2', task_number: 2, title: 'T2', task_date: '2026-06-20', status: 'done', currency: 'INR', billing_amount: 20000, billing_amount_inr: 20000, client_id: 'B', service_id: 'S1' },
    ],
    scores: [
      { task_id: 't1', employee_id: 'e1', score_percentage: 60, earnings_inr: 2100, is_manual_override: false },
      { task_id: 't1', employee_id: 'e2', score_percentage: 40, earnings_inr: 2000, is_manual_override: false },
      { task_id: 't2', employee_id: 'e1', score_percentage: 100, earnings_inr: 5600, is_manual_override: false },
    ],
    pricing: [
      { client_id: 'A', service_id: 'S1', commission_percentage: 50 },
      { client_id: 'B', service_id: 'S1', commission_percentage: 40 },
    ],
    clients: [{ id: 'A', name: 'Acme' }, { id: 'B', name: 'Beta' }],
    services: [{ id: 'S1', name: 'Logo' }],
    empRating: { e1: 70, e2: 100 },
    toolPctByTask: {},
    agreements: [],
  }
}

describe('baseline', () => {
  it('matches the hand-computed engine figures', () => {
    const rows = baselineRows(fixture())
    expect(rows).toHaveLength(2)
    const t1 = rows.find(r => r.task_id === 't1')!
    expect(t1.commission_pool).toBe(5000)
    expect(t1.emp.e1.earn).toBe(2100)
    expect(t1.emp.e2.earn).toBe(2000)
    expect(t1.profit).toBe(10000 - 4100)
    const t2 = rows.find(r => r.task_id === 't2')!
    expect(t2.emp.e1.earn).toBe(5600)
  })
})

describe('lever: performance rating', () => {
  it('scales contribution earnings by newRating/oldRating and leaves others untouched', () => {
    const raw = fixture()
    const s = emptyScenario('s1', 'A')
    s.ratingOverrides.e1 = 100 // 70 → 100
    const rows = simulateScenario(raw, s)
    const t1 = rows.find(r => r.task_id === 't1')!
    // 2100 × (100/70) = 3000
    expect(t1.emp.e1.earn).toBe(3000)
    // Bob unchanged
    expect(t1.emp.e2.earn).toBe(2000)
    const t2 = rows.find(r => r.task_id === 't2')!
    expect(t2.emp.e1.earn).toBe(8000)
  })
})

describe('lever: commission %', () => {
  it('shifts only the targeted client|service pairing; profit moves opposite to earnings', () => {
    const raw = fixture()
    const base = baselineRows(raw)
    const s = emptyScenario('s1', 'A')
    s.commissionOverrides['A|S1'] = 40 // 50 → 40
    const rows = simulateScenario(raw, s)
    const t1 = rows.find(r => r.task_id === 't1')!
    // pool 5000 → 4000; earnings scale by 0.8
    expect(t1.commission_pool).toBe(4000)
    expect(t1.emp.e1.earn).toBe(1680)
    expect(t1.emp.e2.earn).toBe(1600)
    expect(t1.profit).toBeGreaterThan(base.find(r => r.task_id === 't1')!.profit)
    // Other client untouched
    expect(rows.find(r => r.task_id === 't2')!.emp.e1.earn).toBe(5600)
  })
})

describe('lever: price change per client|service', () => {
  it('scales that pairing billings by newPrice/oldPrice', () => {
    const raw = fixture()
    const s = emptyScenario('s1', 'A')
    s.priceOverrides['A|S1'] = { oldPrice: 100, newPrice: 90 } // −10%
    const rows = simulateScenario(raw, s)
    const t1 = rows.find(r => r.task_id === 't1')!
    expect(t1.billing_inr).toBe(9000)
    expect(t1.commission_pool).toBe(4500)
    // t2 (different client) untouched
    expect(rows.find(r => r.task_id === 't2')!.billing_inr).toBe(20000)
  })
})

describe('lever: billing growth %', () => {
  it('scales every billing and compounds with price overrides', () => {
    const raw = fixture()
    const s = emptyScenario('s1', 'A')
    s.billingGrowthPct = 10
    s.priceOverrides['A|S1'] = { oldPrice: 100, newPrice: 90 }
    const rows = simulateScenario(raw, s)
    // t1: 10000 × 1.1 × 0.9 = 9900 ; t2: 20000 × 1.1 = 22000
    expect(rows.find(r => r.task_id === 't1')!.billing_inr).toBe(9900)
    expect(rows.find(r => r.task_id === 't2')!.billing_inr).toBe(22000)
  })
})

describe('lever: draft agreements', () => {
  it('applies a draft percentage_of_billing agreement via the real resolution engine', () => {
    const raw = fixture()
    const s = emptyScenario('s1', 'A')
    s.draftAgreements.push({
      id: 'draft-1', employee_id: 'e1', client_id: 'A', service_id: 'S1',
      agreement_type: 'percentage_of_billing', agreement_value: 15,
    })
    const rows = simulateScenario(raw, s)
    const t1 = rows.find(r => r.task_id === 't1')!
    // 10000 × 15% = 1500 replaces Alice's 2100 on t1
    expect(t1.emp.e1.earn).toBe(1500)
    expect(t1.emp.e1.source).toBe('agreement')
    // t2 (client B) is outside the draft's scope
    expect(rows.find(r => r.task_id === 't2')!.emp.e1.earn).toBe(5600)
  })

  it('loses to a more specific real agreement (honest specificity)', () => {
    const raw = fixture()
    raw.agreements = [{
      id: 'real-1', employee_id: 'e1', client_id: 'A', service_id: 'S1',
      agreement_type: 'fixed_per_task', agreement_value: 999,
      currency: 'INR', effective_from: '2026-01-01', effective_to: null, is_active: true,
    }]
    const s = emptyScenario('s1', 'A')
    // Draft is GLOBAL (less specific than the real exact-match agreement).
    s.draftAgreements.push({
      id: 'draft-1', employee_id: 'e1', client_id: null, service_id: null,
      agreement_type: 'percentage_of_billing', agreement_value: 15,
    })
    const rows = simulateScenario(raw, s)
    expect(rows.find(r => r.task_id === 't1')!.emp.e1.earn).toBe(999)
  })

  it('replaces a real agreement when the draft marks it replaced', () => {
    const raw = fixture()
    raw.agreements = [{
      id: 'real-1', employee_id: 'e1', client_id: 'A', service_id: 'S1',
      agreement_type: 'fixed_per_task', agreement_value: 999,
      currency: 'INR', effective_from: '2026-01-01', effective_to: null, is_active: true,
    }]
    const s = emptyScenario('s1', 'A')
    s.draftAgreements.push({
      id: 'draft-1', employee_id: 'e1', client_id: 'A', service_id: 'S1',
      agreement_type: 'fixed_per_task', agreement_value: 1200,
      replaces_agreement_id: 'real-1',
    })
    const rows = simulateScenario(raw, s)
    expect(rows.find(r => r.task_id === 't1')!.emp.e1.earn).toBe(1200)
  })

  it('never applies to manual overrides', () => {
    const raw = fixture()
    raw.scores[0].is_manual_override = true
    const s = emptyScenario('s1', 'A')
    s.draftAgreements.push({
      id: 'draft-1', employee_id: 'e1', client_id: 'A', service_id: 'S1',
      agreement_type: 'percentage_of_billing', agreement_value: 15,
    })
    const rows = simulateScenario(raw, s)
    const t1 = rows.find(r => r.task_id === 't1')!
    expect(t1.emp.e1.source).toBe('manual_override')
  })
})

describe('compareScenario', () => {
  it('aggregates revenue/commission/profit/payroll and per-employee salary projections', () => {
    const raw = fixture()
    const s = emptyScenario('s1', 'A')
    s.ratingOverrides.e1 = 100
    s.salaryIncrements.e1 = { mode: 'amount', value: 5000 }
    const cmp = compareScenario(
      baselineRows(raw), simulateScenario(raw, s), EMPLOYEES,
      { e1: 30000, e2: 25000 }, s,
    )
    // Current: earnings 2100+2000+5600 = 9700; revenue 30000; profit 20300
    expect(cmp.revenue.current).toBe(30000)
    expect(cmp.commissionCost.current).toBe(9700)
    expect(cmp.profit.current).toBe(20300)
    // Simulated: Alice 3000+8000, Bob 2000 → 13000
    expect(cmp.commissionCost.simulated).toBe(13000)
    expect(cmp.profit.simulated).toBe(17000)
    // Payroll: current 9700 + 55000 = 64700; simulated 13000 + 55000 + 5000 = 73000
    expect(cmp.payrollCost.current).toBe(64700)
    expect(cmp.payrollCost.simulated).toBe(73000)
    const alice = cmp.perEmployee.find(e => e.id === 'e1')!
    expect(alice.currentSalary).toBe(30000 + 7700)
    expect(alice.projectedSalary).toBe(30000 + 5000 + 11000)
    // Per-client margin present for both clients
    expect(cmp.perClient).toHaveLength(2)
  })

  it('degrades to commission-only payroll when salaries are hidden', () => {
    const raw = fixture()
    const s = emptyScenario('s1', 'A')
    const cmp = compareScenario(baselineRows(raw), simulateScenario(raw, s), EMPLOYEES, null, s)
    expect(cmp.payrollCost.current).toBe(9700)
    expect(cmp.perEmployee[0].projectedSalary).toBeNull()
  })
})

describe('goalSeek', () => {
  it('finds the global commission % that hits a profit-margin target', () => {
    const raw = fixture()
    // margin(c) = 1 − earnings(c)/30000. At c=50/40 baseline margin ≈ 67.67%.
    // Solve for 75% margin → total earnings must be 7,500.
    const res = goalSeek(raw, emptyScenario('g', 'G'), { kind: 'profit_margin_pct', target: 75 }, { kind: 'global_commission_pct' }, null)
    expect(res.value).not.toBeNull()
    // Verify: applying the found commission % actually yields ~75% margin.
    const s = emptyScenario('v', 'V')
    for (const key of ['A|S1', 'B|S1']) s.commissionOverrides[key] = res.value!
    const rows = simulateScenario(raw, s)
    const margin = rows.reduce((a, r) => a + r.profit, 0) / 30000 * 100
    expect(Math.abs(margin - 75)).toBeLessThan(0.1)
  })

  it('reports unreachable targets as null with the closest achievable value', () => {
    const raw = fixture()
    // 200% margin is impossible.
    const res = goalSeek(raw, emptyScenario('g', 'G'), { kind: 'profit_margin_pct', target: 200 }, { kind: 'global_commission_pct' }, null)
    expect(res.value).toBeNull()
  })

  it('solves an employee-earnings target via their rating', () => {
    const raw = fixture()
    // Alice at rating r earns (5000×0.6 + 8000×1.0) × r/100 = 110×r. Target ₹8,800 → r = 80.
    const res = goalSeek(raw, emptyScenario('g', 'G'), { kind: 'employee_earnings', employeeId: 'e1', target: 8800 }, { kind: 'employee_rating', employeeId: 'e1' }, null)
    expect(res.value).not.toBeNull()
    expect(Math.abs(res.value! - 80)).toBeLessThan(0.1)
  })
})

describe('helpers', () => {
  it('isScenarioEmpty and resolveIncrement', () => {
    const s = emptyScenario('x', 'X')
    expect(isScenarioEmpty(s)).toBe(true)
    s.billingGrowthPct = 5
    expect(isScenarioEmpty(s)).toBe(false)
    expect(resolveIncrement(30000, { mode: 'pct', value: 10 })).toBe(3000)
    expect(resolveIncrement(30000, { mode: 'amount', value: 2500 })).toBe(2500)
    expect(resolveIncrement(30000, undefined)).toBe(0)
  })
})
