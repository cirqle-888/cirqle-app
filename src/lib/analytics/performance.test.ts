/**
 * Unit tests for src/lib/analytics/performance.ts
 *
 * Run with:  npx jest src/lib/analytics/performance.test.ts
 *
 * Mirrors the commission.ts calculation engine — every expected value is derived
 * from first principles so we can catch regressions if commission.ts changes.
 *
 * Test inventory:
 *  [T1]  aggregateEmployeeByParameter — single employee solo task
 *  [T2]  aggregateEmployeeByParameter — even two-employee split
 *  [T3]  aggregateEmployeeByParameter — uneven split (70/30)
 *  [T4]  aggregateEmployeeByParameter — inactive parameter skipped (commission.ts rule)
 *  [T5]  aggregateEmployeeByParameter — employee on multiple tasks, score averaged
 *  [T6]  aggregateEmployeeByGroup — single active group, weighted roll-up
 *  [T7]  aggregateEmployeeByGroup — two active groups, normalised per group
 *  [T8]  aggregateEmployeeByGroup — inactive group not counted
 *  [T9]  inferProductionOwner — solo contributor
 *  [T10] inferProductionOwner — two employees, dominant winner
 *  [T11] inferProductionOwner — missing master param → fallback to highest weight
 *  [T12] inferProductionOwner — empty contributions → null
 *  [T13] inferProductionOwner — multiple groups, picks dominant group's master
 *  [T14] bandStrength — threshold boundaries
 *  [T15] bandStrength — insufficient data (taskCount < MIN_TASKS_FOR_BAND)
 *  [T16] teamCoverage — bus-factor risk levels
 *  [T17] employeeSummary — top strengths + growth area + versatility
 *  [T18] parameterTrend — monthly aggregation, sparse months omitted
 */

import {
  aggregateEmployeeByParameter,
  aggregateEmployeeByGroup,
  inferProductionOwner,
  bandStrength,
  teamCoverage,
  employeeSummary,
  parameterTrend,
  MIN_TASKS_FOR_BAND,
  ContribRow,
  Param,
  Group,
} from './performance'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const GROUPS: Group[] = [
  { id: 'g-design',   name: 'Design',   weight: 50 },
  { id: 'g-variable', name: 'Variable', weight: 50 },
]

const PARAMS: Param[] = [
  // Design group
  { id: 'p-concept',   group_id: 'g-design',   name: 'Concept',   weight: 1,    is_master: true,  input_type: 'percentage' },
  { id: 'p-execution', group_id: 'g-design',   name: 'Execution', weight: 0.48, is_master: false, input_type: 'count' },
  { id: 'p-revision',  group_id: 'g-design',   name: 'Revision',  weight: 0.04, is_master: false, input_type: 'count' },
  // Variable group
  { id: 'p-product',   group_id: 'g-variable', name: 'Products',  weight: 1,    is_master: true,  input_type: 'count' },
  { id: 'p-photo',     group_id: 'g-variable', name: 'Photo',     weight: 0.02, is_master: false, input_type: 'count' },
]

const EMP_A = 'emp-alice'
const EMP_B = 'emp-bob'
const EMP_C = 'emp-charlie'

// ─────────────────────────────────────────────────────────────────────────────
// aggregateEmployeeByParameter
// ─────────────────────────────────────────────────────────────────────────────

test('[T1] single employee — solo task — score = 1.0', () => {
  const contribs: ContribRow[] = [
    { task_id: 't1', employee_id: EMP_A, parameter_id: 'p-concept', value: 100 },
  ]
  const result = aggregateEmployeeByParameter(contribs, PARAMS)
  expect(result[EMP_A]['p-concept'].score).toBeCloseTo(1.0)
  expect(result[EMP_A]['p-concept'].taskCount).toBe(1)
})

test('[T2] even two-employee split — each gets 0.5', () => {
  const contribs: ContribRow[] = [
    { task_id: 't1', employee_id: EMP_A, parameter_id: 'p-execution', value: 5 },
    { task_id: 't1', employee_id: EMP_B, parameter_id: 'p-execution', value: 5 },
  ]
  const result = aggregateEmployeeByParameter(contribs, PARAMS)
  expect(result[EMP_A]['p-execution'].score).toBeCloseTo(0.5)
  expect(result[EMP_B]['p-execution'].score).toBeCloseTo(0.5)
  expect(result[EMP_A]['p-execution'].taskCount).toBe(1)
})

test('[T3] uneven 70/30 split', () => {
  const contribs: ContribRow[] = [
    { task_id: 't1', employee_id: EMP_A, parameter_id: 'p-revision', value: 7 },
    { task_id: 't1', employee_id: EMP_B, parameter_id: 'p-revision', value: 3 },
  ]
  const result = aggregateEmployeeByParameter(contribs, PARAMS)
  expect(result[EMP_A]['p-revision'].score).toBeCloseTo(0.7)
  expect(result[EMP_B]['p-revision'].score).toBeCloseTo(0.3)
})

test('[T4] inactive parameter (totalValue=0) is skipped — mirrors commission.ts rule', () => {
  // Only EMP_A touches p-concept; p-execution has value=0 so should be ignored
  const contribs: ContribRow[] = [
    { task_id: 't1', employee_id: EMP_A, parameter_id: 'p-concept',   value: 100 },
    { task_id: 't1', employee_id: EMP_A, parameter_id: 'p-execution', value: 0   },
  ]
  const result = aggregateEmployeeByParameter(contribs, PARAMS)
  expect(result[EMP_A]['p-concept'].taskCount).toBe(1)
  // p-execution row has value 0 — totalValue = 0 → skipped → no entry
  expect(result[EMP_A]['p-execution']).toBeUndefined()
})

test('[T5] employee on multiple tasks — score is mean across tasks', () => {
  // Task t1: Alice 100%, Bob 0%  → Alice share = 1.0
  // Task t2: Alice 50%, Bob 50%  → Alice share = 0.5
  // Expected Alice mean = 0.75
  const contribs: ContribRow[] = [
    { task_id: 't1', employee_id: EMP_A, parameter_id: 'p-concept', value: 100 },
    { task_id: 't1', employee_id: EMP_B, parameter_id: 'p-concept', value: 0   },
    { task_id: 't2', employee_id: EMP_A, parameter_id: 'p-concept', value: 50  },
    { task_id: 't2', employee_id: EMP_B, parameter_id: 'p-concept', value: 50  },
  ]
  const result = aggregateEmployeeByParameter(contribs, PARAMS)
  // t1: totalVal = 100, Alice share = 1.0. Bob has 0 so is skipped (totalVal=100, share=0)
  // Actually Bob value is 0, so Alice share = 100/100=1.0. Bob row: 0/100=0 — this IS counted.
  // t2: Alice 50/100 = 0.5
  // Alice mean: (1.0 + 0.5)/2 = 0.75
  expect(result[EMP_A]['p-concept'].score).toBeCloseTo(0.75)
  expect(result[EMP_A]['p-concept'].taskCount).toBe(2)
})

// ─────────────────────────────────────────────────────────────────────────────
// aggregateEmployeeByGroup
// ─────────────────────────────────────────────────────────────────────────────

test('[T6] single active group — weighted roll-up', () => {
  // Design group only. p-concept (weight 1) and p-execution (weight 0.48) active.
  // Alice: concept 60/100, execution 3/5.
  // totalActiveWeightSum = 1 + 0.48 = 1.48
  // empGroupScore = (60/100)*1 + (3/5)*0.48 = 0.6 + 0.288 = 0.888
  // normalizedGroupScore = 0.888 / 1.48 ≈ 0.5999
  const contribs: ContribRow[] = [
    { task_id: 't1', employee_id: EMP_A, parameter_id: 'p-concept',   value: 60 },
    { task_id: 't1', employee_id: EMP_B, parameter_id: 'p-concept',   value: 40 },
    { task_id: 't1', employee_id: EMP_A, parameter_id: 'p-execution', value: 3  },
    { task_id: 't1', employee_id: EMP_B, parameter_id: 'p-execution', value: 2  },
  ]
  const result = aggregateEmployeeByGroup(contribs, PARAMS, GROUPS)
  const empADesign = result[EMP_A]['g-design']
  expect(empADesign).toBeDefined()
  expect(empADesign.score).toBeCloseTo(0.6, 2)
  expect(empADesign.taskCount).toBe(1)
})

test('[T7] two active groups — each normalised independently', () => {
  // Group Design: Alice 100% of concept
  // Group Variable: Bob 100% of product
  // Both in the same task
  const contribs: ContribRow[] = [
    { task_id: 't1', employee_id: EMP_A, parameter_id: 'p-concept', value: 100 },
    { task_id: 't1', employee_id: EMP_B, parameter_id: 'p-product', value: 5   },
  ]
  const result = aggregateEmployeeByGroup(contribs, PARAMS, GROUPS)
  // Alice: g-design score = 1.0 (sole contributor to active params in design group)
  //        g-variable: no contribution → no entry
  // Bob:   g-variable score = 1.0 (sole contributor)
  //        g-design: no contribution → no entry
  expect(result[EMP_A]['g-design'].score).toBeCloseTo(1.0)
  expect(result[EMP_A]['g-variable']).toBeUndefined()
  expect(result[EMP_B]['g-variable'].score).toBeCloseTo(1.0)
  expect(result[EMP_B]['g-design']).toBeUndefined()
})

test('[T8] group with only zero-value contributions is skipped', () => {
  const contribs: ContribRow[] = [
    { task_id: 't1', employee_id: EMP_A, parameter_id: 'p-concept', value: 100 },
    { task_id: 't1', employee_id: EMP_A, parameter_id: 'p-product', value: 0   }, // inactive
  ]
  const result = aggregateEmployeeByGroup(contribs, PARAMS, GROUPS)
  expect(result[EMP_A]['g-design']).toBeDefined()
  expect(result[EMP_A]['g-variable']).toBeUndefined()  // all params zero → group skipped
})

// ─────────────────────────────────────────────────────────────────────────────
// inferProductionOwner
// ─────────────────────────────────────────────────────────────────────────────

test('[T9] sole contributor — confidence = 10 (capped)', () => {
  const contribs: ContribRow[] = [
    { task_id: 't1', employee_id: EMP_A, parameter_id: 'p-concept', value: 100 },
  ]
  const result = inferProductionOwner('t1', contribs, PARAMS)
  expect(result?.employeeId).toBe(EMP_A)
  expect(result?.confidence).toBe(10)
})

test('[T10] two employees — dominant winner by master param value', () => {
  // Alice 80, Bob 20 on the master param (p-concept in Design group)
  const contribs: ContribRow[] = [
    { task_id: 't1', employee_id: EMP_A, parameter_id: 'p-concept', value: 80 },
    { task_id: 't1', employee_id: EMP_B, parameter_id: 'p-concept', value: 20 },
  ]
  const result = inferProductionOwner('t1', contribs, PARAMS)
  expect(result?.employeeId).toBe(EMP_A)
  expect(result?.confidence).toBeCloseTo(4.0)  // 80/20 = 4.0
})

test('[T11] missing is_master — fallback to highest weight param', () => {
  // Custom params where is_master is all false — should fall back to weight sort
  const customParams: Param[] = [
    { id: 'p-a', group_id: 'g-design', name: 'A', weight: 0.8, is_master: false },
    { id: 'p-b', group_id: 'g-design', name: 'B', weight: 1.0, is_master: false }, // highest weight
  ]
  const contribs: ContribRow[] = [
    { task_id: 't1', employee_id: EMP_A, parameter_id: 'p-b', value: 10 },
    { task_id: 't1', employee_id: EMP_B, parameter_id: 'p-b', value: 5  },
  ]
  const result = inferProductionOwner('t1', contribs, customParams)
  expect(result?.employeeId).toBe(EMP_A)
})

test('[T12] empty contributions → null', () => {
  expect(inferProductionOwner('t1', [], PARAMS)).toBeNull()
})

test('[T13] two groups, dominant group wins by total sum', () => {
  // Variable group (product=50 total) > Design group (concept=30 total)
  // → dominant = Variable → master = p-product → Alice wins (40 > Bob 10)
  const contribs: ContribRow[] = [
    { task_id: 't1', employee_id: EMP_A, parameter_id: 'p-concept', value: 20 },
    { task_id: 't1', employee_id: EMP_B, parameter_id: 'p-concept', value: 10 },
    { task_id: 't1', employee_id: EMP_A, parameter_id: 'p-product', value: 40 },
    { task_id: 't1', employee_id: EMP_B, parameter_id: 'p-product', value: 10 },
  ]
  const result = inferProductionOwner('t1', contribs, PARAMS)
  // Variable group total = 50, Design group total = 30 → Variable dominant
  // p-product master: Alice 40, Bob 10 → Alice owns
  expect(result?.employeeId).toBe(EMP_A)
})

// ─────────────────────────────────────────────────────────────────────────────
// bandStrength
// ─────────────────────────────────────────────────────────────────────────────

test('[T14] band threshold boundaries', () => {
  const N = MIN_TASKS_FOR_BAND  // sufficient count
  expect(bandStrength(1.00, N)).toBe('Expert')
  expect(bandStrength(0.75, N)).toBe('Expert')
  expect(bandStrength(0.74, N)).toBe('Strong')
  expect(bandStrength(0.50, N)).toBe('Strong')
  expect(bandStrength(0.49, N)).toBe('Developing')
  expect(bandStrength(0.25, N)).toBe('Developing')
  expect(bandStrength(0.24, N)).toBe('Learning')
  expect(bandStrength(0.00, N)).toBe('Learning')
})

test('[T15] insufficient data regardless of score', () => {
  expect(bandStrength(1.0, 0)).toBe('Insufficient')
  expect(bandStrength(1.0, MIN_TASKS_FOR_BAND - 1)).toBe('Insufficient')
  expect(bandStrength(1.0, MIN_TASKS_FOR_BAND)).toBe('Expert')
})

// ─────────────────────────────────────────────────────────────────────────────
// teamCoverage
// ─────────────────────────────────────────────────────────────────────────────

test('[T16] bus-factor risk levels', () => {
  const N = MIN_TASKS_FOR_BAND

  // Build a synthetic aggregated result for p-concept
  const makeAgg = (entries: Array<[string, number]>) => {
    const agg: Record<string, Record<string, { score: number; taskCount: number }>> = {}
    for (const [empId, score] of entries) {
      agg[empId] = { 'p-concept': { score, taskCount: N } }
    }
    return agg
  }

  expect(teamCoverage(makeAgg([['e1', 0.8]]),                               'p-concept').risk).toBe('high')   // 1 strong
  expect(teamCoverage(makeAgg([['e1', 0.8], ['e2', 0.6]]),                  'p-concept').risk).toBe('medium') // 2 strong
  expect(teamCoverage(makeAgg([['e1', 0.8], ['e2', 0.6], ['e3', 0.55]]),    'p-concept').risk).toBe('low')    // 3 strong
  expect(teamCoverage(makeAgg([['e1', 0.1]]),                               'p-concept').risk).toBe('high')   // 1 but Learning → 0 strong
  expect(teamCoverage(makeAgg([]),                                           'p-concept').risk).toBe('high')   // no data
})

// ─────────────────────────────────────────────────────────────────────────────
// employeeSummary
// ─────────────────────────────────────────────────────────────────────────────

test('[T17] employeeSummary — top strengths, growth area, versatility', () => {
  const N = MIN_TASKS_FOR_BAND
  const agg: Record<string, Record<string, { score: number; taskCount: number }>> = {
    [EMP_A]: {
      'p-concept':   { score: 0.85, taskCount: N },  // Expert
      'p-execution': { score: 0.60, taskCount: N },  // Strong
      'p-revision':  { score: 0.30, taskCount: N },  // Developing — growth area
      'p-product':   { score: 0.20, taskCount: N },  // Learning
      // p-photo not touched — not in emp data
    },
  }
  const summary = employeeSummary(EMP_A, agg, PARAMS)

  // top strengths: Expert + Strong, sorted desc
  expect(summary.topStrengths.length).toBeLessThanOrEqual(3)
  expect(summary.topStrengths[0].parameterId).toBe('p-concept')
  expect(summary.topStrengths[0].band).toBe('Expert')
  expect(summary.topStrengths[1].parameterId).toBe('p-execution')
  expect(summary.topStrengths[1].band).toBe('Strong')

  // growth area: lowest scored that has ≥ MIN_TASKS_FOR_BAND and isn't Expert
  expect(summary.growthArea?.parameterId).toBe('p-product')  // lowest non-Expert (0.20)

  // versatility: 4 of 5 params touched
  expect(summary.versatility.active).toBe(4)
  expect(summary.versatility.total).toBe(5)
  expect(summary.versatility.fraction).toBeCloseTo(0.8)
})

// ─────────────────────────────────────────────────────────────────────────────
// parameterTrend
// ─────────────────────────────────────────────────────────────────────────────

test('[T18] parameterTrend — monthly aggregation, sparse months omitted', () => {
  type EnrichedRow = ContribRow & { task_date: string }

  const contribs: EnrichedRow[] = [
    // Jan: Alice 100%
    { task_id: 't1', employee_id: EMP_A, parameter_id: 'p-concept', value: 100, task_date: '2026-01-10' },
    // Feb: Alice 50%, Bob 50%
    { task_id: 't2', employee_id: EMP_A, parameter_id: 'p-concept', value: 50,  task_date: '2026-02-05' },
    { task_id: 't2', employee_id: EMP_B, parameter_id: 'p-concept', value: 50,  task_date: '2026-02-05' },
    // Mar: Bob only (Alice absent)
    { task_id: 't3', employee_id: EMP_B, parameter_id: 'p-concept', value: 80,  task_date: '2026-03-15' },
    // Different parameter — should be ignored
    { task_id: 't4', employee_id: EMP_A, parameter_id: 'p-execution', value: 5, task_date: '2026-01-20' },
  ]

  const trend = parameterTrend(EMP_A, 'p-concept', contribs)

  // Alice: Jan score = 1.0, Feb score = 0.5. Mar = absent → omitted.
  expect(trend).toHaveLength(2)
  expect(trend[0].month).toBe('2026-01')
  expect(trend[0].score).toBeCloseTo(1.0)
  expect(trend[1].month).toBe('2026-02')
  expect(trend[1].score).toBeCloseTo(0.5)
})
