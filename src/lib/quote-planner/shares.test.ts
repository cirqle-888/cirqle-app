import { describe, it, expect } from 'vitest'
import { historicalShares, applyOverrides, type ScoreRow, type TaskRow } from './shares'

const TASKS: TaskRow[] = [
  { id: 't1', service_id: 'flyer' },
  { id: 't2', service_id: 'flyer' },
  { id: 't3', service_id: 'social' },
]

describe('historicalShares', () => {
  it('averages each employee across that service only', () => {
    const scores: ScoreRow[] = [
      { task_id: 't1', employee_id: 'e1', score_percentage: 60 },
      { task_id: 't1', employee_id: 'e2', score_percentage: 40 },
      { task_id: 't2', employee_id: 'e1', score_percentage: 60 },
      { task_id: 't2', employee_id: 'e2', score_percentage: 40 },
      // Another service entirely — must not leak in.
      { task_id: 't3', employee_id: 'e3', score_percentage: 100 },
    ]
    const out = historicalShares({ scores, tasks: TASKS, serviceId: 'flyer' })
    expect(out.map(o => o.employeeId)).toEqual(['e1', 'e2'])
    expect(out[0].sharePct).toBe(60)
    expect(out[1].sharePct).toBe(40)
  })

  it('rescales to a whole split when the raw averages do not sum to 100', () => {
    // A rotating pair: each appears on half the tasks at 50%, so raw means are
    // 50 and 50 but they never worked together. Seeding 50/50 unscaled would
    // under-assign the pool.
    const scores: ScoreRow[] = [
      { task_id: 't1', employee_id: 'e1', score_percentage: 100 },
      { task_id: 't2', employee_id: 'e2', score_percentage: 100 },
    ]
    const out = historicalShares({ scores, tasks: TASKS, serviceId: 'flyer' })
    expect(out.reduce((s, o) => s + o.sharePct, 0)).toBe(100)
  })

  it('is empty for a service nobody has worked', () => {
    expect(historicalShares({ scores: [], tasks: TASKS, serviceId: 'flyer' })).toEqual([])
  })

  it('is empty for a service that does not exist, rather than throwing', () => {
    const scores: ScoreRow[] = [{ task_id: 't1', employee_id: 'e1', score_percentage: 60 }]
    expect(historicalShares({ scores, tasks: TASKS, serviceId: 'nope' })).toEqual([])
  })

  it('ignores zero and negative scores', () => {
    const scores: ScoreRow[] = [
      { task_id: 't1', employee_id: 'e1', score_percentage: 100 },
      { task_id: 't1', employee_id: 'e2', score_percentage: 0 },
      { task_id: 't2', employee_id: 'e3', score_percentage: null },
    ]
    const out = historicalShares({ scores, tasks: TASKS, serviceId: 'flyer' })
    expect(out.map(o => o.employeeId)).toEqual(['e1'])
    expect(out[0].sharePct).toBe(100)
  })

  it('can drop people seen on too few tasks', () => {
    const scores: ScoreRow[] = [
      { task_id: 't1', employee_id: 'e1', score_percentage: 50 },
      { task_id: 't2', employee_id: 'e1', score_percentage: 50 },
      { task_id: 't1', employee_id: 'e2', score_percentage: 50 },
    ]
    const out = historicalShares({ scores, tasks: TASKS, serviceId: 'flyer', minTasks: 2 })
    expect(out.map(o => o.employeeId)).toEqual(['e1'])
  })

  it('reports how many tasks each average rests on', () => {
    const scores: ScoreRow[] = [
      { task_id: 't1', employee_id: 'e1', score_percentage: 50 },
      { task_id: 't2', employee_id: 'e1', score_percentage: 50 },
    ]
    expect(historicalShares({ scores, tasks: TASKS, serviceId: 'flyer' })[0].taskCount).toBe(2)
  })
})

describe('applyOverrides', () => {
  it('replaces only what the planner has set', () => {
    const base = [
      { employeeId: 'e1', sharePct: 60, taskCount: 3 },
      { employeeId: 'e2', sharePct: 40, taskCount: 3 },
    ]
    const out = applyOverrides(base, { e1: 80 })
    expect(out[0].sharePct).toBe(80)
    expect(out[1].sharePct).toBe(40)
  })
})
