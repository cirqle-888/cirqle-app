import { describe, it, expect } from 'vitest'
import { calculateCommission, TaskContributionInput } from './commission'

// Regression guard for the weight-normalization behaviour the whole
// Groups & Params UI now documents: group weights are RELATIVE importance
// values, normalized over the groups active on each task. These tests pin
// that contract so a future engine change can't silently reintroduce the
// "weights must sum to 100" assumption.

const emp = (id: string, rating = 100) => ({
  id, name: id, performance_rating: rating,
} as any)

const group = (id: string, weight: number) => ({
  id, name: `${id} Group`, weight, is_active: true, display_order: 0,
} as any)

const param = (id: string, groupId: string, weight = 1) => ({
  id, group_id: groupId, name: id, weight, is_active: true, display_order: 0,
} as any)

const contrib = (empId: string, paramId: string, value: number) => ({
  id: '', task_id: 't1', employee_id: empId, parameter_id: paramId,
  value, locked: false, created_at: '', updated_at: '',
} as any)

function base(overrides: Partial<TaskContributionInput>): TaskContributionInput {
  return {
    taskId: 't1',
    billingAmountINR: 1000,
    serviceCommissionPct: 50,   // pool = 500
    employees: [],
    groups: [],
    parameters: [],
    toolsUsed: [],
    contributions: [],
    ...overrides,
  }
}

describe('calculateCommission — relative group weights', () => {
  it('three 50-weight groups normalize to a third each; scores sum to 100 and earnings equal the pool', () => {
    const input = base({
      employees: [emp('a'), emp('b'), emp('c')],
      groups: [group('g1', 50), group('g2', 50), group('g3', 50)],
      parameters: [param('p1', 'g1'), param('p2', 'g2'), param('p3', 'g3')],
      contributions: [
        contrib('a', 'p1', 1),   // a owns all of g1
        contrib('b', 'p2', 1),   // b owns all of g2
        contrib('c', 'p3', 1),   // c owns all of g3
      ],
    })
    const res = calculateCommission(input)
    expect(res.employeePool).toBe(500)
    for (const e of res.employeeEarnings) {
      expect(e.scorePercentage).toBeCloseTo(100 / 3, 5)
      expect(e.earnings).toBeCloseTo(500 / 3, 5)
    }
    const totalScore = res.employeeEarnings.reduce((s, e) => s + e.scorePercentage, 0)
    const totalEarn = res.employeeEarnings.reduce((s, e) => s + e.earnings, 0)
    expect(totalScore).toBeCloseTo(100, 5)
    expect(totalEarn).toBeCloseTo(500, 5)
  })

  it('weights that sum over 100 never overpay: payout equals the pool exactly', () => {
    const input = base({
      employees: [emp('a'), emp('b')],
      groups: [group('g1', 90), group('g2', 60)],   // sum = 150
      parameters: [param('p1', 'g1'), param('p2', 'g2')],
      contributions: [contrib('a', 'p1', 1), contrib('b', 'p2', 1)],
    })
    const res = calculateCommission(input)
    expect(res.employeeEarnings.find(e => e.employeeId === 'a')!.scorePercentage).toBeCloseTo(60, 5)  // 90/150
    expect(res.employeeEarnings.find(e => e.employeeId === 'b')!.scorePercentage).toBeCloseTo(40, 5)  // 60/150
    expect(res.employeeEarnings.reduce((s, e) => s + e.earnings, 0)).toBeCloseTo(500, 5)
  })

  it('weights that sum under 100 never underpay: full pool is still distributed', () => {
    const input = base({
      employees: [emp('a'), emp('b')],
      groups: [group('g1', 30), group('g2', 20)],   // sum = 50
      parameters: [param('p1', 'g1'), param('p2', 'g2')],
      contributions: [contrib('a', 'p1', 1), contrib('b', 'p2', 1)],
    })
    const res = calculateCommission(input)
    expect(res.employeeEarnings.find(e => e.employeeId === 'a')!.scorePercentage).toBeCloseTo(60, 5)
    expect(res.employeeEarnings.find(e => e.employeeId === 'b')!.scorePercentage).toBeCloseTo(40, 5)
    expect(res.employeeEarnings.reduce((s, e) => s + e.earnings, 0)).toBeCloseTo(500, 5)
  })

  it('a single active group takes 100% of the pool regardless of its stored weight', () => {
    const input = base({
      employees: [emp('a')],
      groups: [group('g1', 50), group('g2', 50), group('g3', 50)],
      parameters: [param('p1', 'g1'), param('p2', 'g2'), param('p3', 'g3')],
      contributions: [contrib('a', 'p1', 4)],   // only g1 has data
    })
    const res = calculateCommission(input)
    expect(res.employeeEarnings).toHaveLength(1)
    expect(res.employeeEarnings[0].scorePercentage).toBeCloseTo(100, 5)
    expect(res.employeeEarnings[0].earnings).toBeCloseTo(500, 5)
  })

  it('inactive extra groups passed in (all-groups fallback) change nothing', () => {
    const two = base({
      employees: [emp('a'), emp('b')],
      groups: [group('g1', 50), group('g2', 50)],
      parameters: [param('p1', 'g1'), param('p2', 'g2')],
      contributions: [contrib('a', 'p1', 1), contrib('b', 'p2', 1)],
    })
    const withExtras = {
      ...two,
      groups: [...two.groups, group('g3', 50), group('g4', 999)],   // no params/data
    }
    const a = calculateCommission(two)
    const b = calculateCommission(withExtras)
    expect(b.employeeEarnings).toEqual(a.employeeEarnings)
  })

  it('performance rating scales an employee’s cut without redistribution', () => {
    const input = base({
      employees: [emp('a', 50), emp('b', 100)],
      groups: [group('g1', 50)],
      parameters: [param('p1', 'g1')],
      contributions: [contrib('a', 'p1', 1), contrib('b', 'p1', 1)],
    })
    const res = calculateCommission(input)
    expect(res.employeeEarnings.find(e => e.employeeId === 'a')!.earnings).toBeCloseTo(125, 5)  // 250 × 50%
    expect(res.employeeEarnings.find(e => e.employeeId === 'b')!.earnings).toBeCloseTo(250, 5)
  })

  it('tool deduction comes off the pool and is charged to the owning group’s share', () => {
    const input = base({
      employees: [emp('a'), emp('b')],
      groups: [group('g1', 50), group('g2', 50)],
      parameters: [param('p1', 'g1'), param('p2', 'g2')],
      toolsUsed: [{ tool: { id: 'tl', name: 'Ideogram', group_id: 'g1', fixed_percentage: 10 } as any, used: true }],
      contributions: [contrib('a', 'p1', 1), contrib('b', 'p2', 1)],
    })
    const res = calculateCommission(input)
    // Worked example from the engine comments: shares become 40/90 and 50/90 of the 90% pool.
    expect(res.remainingPool).toBeCloseTo(450, 5)
    expect(res.employeeEarnings.find(e => e.employeeId === 'a')!.earnings).toBeCloseTo(450 * (40 / 90), 5)
    expect(res.employeeEarnings.find(e => e.employeeId === 'b')!.earnings).toBeCloseTo(450 * (50 / 90), 5)
  })

  it('unused sub-parameters do not dilute the group score', () => {
    const input = base({
      employees: [emp('a'), emp('b')],
      groups: [group('g1', 50)],
      parameters: [param('master', 'g1', 1), param('revisions', 'g1', 0.5)],
      contributions: [contrib('a', 'master', 75), contrib('b', 'master', 25)],  // nobody used revisions
    })
    const res = calculateCommission(input)
    expect(res.employeeEarnings.find(e => e.employeeId === 'a')!.scorePercentage).toBeCloseTo(75, 5)
    expect(res.employeeEarnings.find(e => e.employeeId === 'b')!.scorePercentage).toBeCloseTo(25, 5)
  })
})
