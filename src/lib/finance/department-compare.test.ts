import { describe, it, expect } from 'vitest'
import { departmentComparison, previousWindow, change } from './department-compare'
import { departmentFlows, UNASSIGNED_DEPT, type DeptDayFact } from './department-flows'

const fact = (f: Partial<DeptDayFact> & { date: string; deptId: string }): DeptDayFact =>
  ({ jobs: 0, jobValueInr: 0, billedInr: 0, inflowInr: 0, contributionPayInr: 0, ...f })

describe('previousWindow', () => {
  const nov = { from: '2026-11-01', to: '2026-11-11' }
  const oct = { from: '2026-10-01', to: '2026-10-31' }

  it('cuts the previous period to the days elapsed so far', () => {
    expect(previousWindow(nov, oct, true)).toEqual({ from: '2026-10-01', to: '2026-10-11' })
  })

  it('never runs past the previous period’s own end', () => {
    // 31 days into March vs a 28-day February.
    expect(previousWindow({ from: '2027-03-01', to: '2027-03-31' }, { from: '2027-02-01', to: '2027-02-28' }, true))
      .toEqual({ from: '2027-02-01', to: '2027-02-28' })
  })

  it('returns the whole previous period when asked', () => {
    expect(previousWindow(nov, oct, false)).toEqual(oct)
  })
})

describe('change', () => {
  it('gives ₹ and % change', () => {
    expect(change(1500, 1000)).toEqual({ current: 1500, previous: 1000, delta: 500, pct: 50 })
    expect(change(500, 1000).pct).toBe(-50)
  })

  it('has no % from nothing or from a negative', () => {
    expect(change(800, 0).pct).toBeNull()
    expect(change(300, -200)).toMatchObject({ delta: 500, pct: null })
  })
})

describe('departmentComparison', () => {
  const facts = [
    fact({ date: '2026-10-03', deptId: 'design', jobs: 2, jobValueInr: 2000, billedInr: 4000, inflowInr: 3000, contributionPayInr: 1000 }),
    fact({ date: '2026-10-20', deptId: 'design', jobs: 5, billedInr: 9000 }),                    // after Oct 11
    fact({ date: '2026-11-04', deptId: 'design', jobs: 3, jobValueInr: 3000, billedInr: 6000, inflowInr: 5000, contributionPayInr: 1500 }),
    fact({ date: '2026-11-05', deptId: 'video', jobs: 1, jobValueInr: 1000, billedInr: 2000, inflowInr: 1000 }),
    fact({ date: '2026-10-05', deptId: UNASSIGNED_DEPT, inflowInr: 400 }),
  ]
  const cur = { window: { from: '2026-11-01', to: '2026-11-11' }, outflowInr: 3500 }
  const prev = { window: { from: '2026-10-01', to: '2026-10-11' }, outflowInr: 2000 }

  it('gives each side exactly what the card shows for that window', () => {
    const { rows } = departmentComparison(facts, cur, prev)
    const design = rows.find(r => r.deptId === 'design')!
    const curCard = departmentFlows(facts, cur.window, cur.outflowInr).find(r => r.deptId === 'design')!
    const prevCard = departmentFlows(facts, prev.window, prev.outflowInr).find(r => r.deptId === 'design')!
    for (const m of ['jobs', 'billedInr', 'inflowInr', 'outflowInr', 'netInr'] as const) {
      expect(design.metrics[m].current).toBe(curCard[m])
      expect(design.metrics[m].previous).toBe(prevCard[m])
    }
    expect(design.metrics.jobs).toMatchObject({ current: 3, previous: 2, delta: 1, pct: 50 })
  })

  it('keeps a department active on only one side, at zero on the other', () => {
    const { rows } = departmentComparison(facts, cur, prev)
    expect(rows.find(r => r.deptId === 'video')!.metrics.billedInr).toMatchObject({ current: 2000, previous: 0, pct: null })
    expect(rows.find(r => r.deptId === UNASSIGNED_DEPT)!.metrics.inflowInr).toMatchObject({ current: 0, previous: 400 })
  })

  it('orders by revenue with Unassigned last, and totals both sides', () => {
    const { rows, total } = departmentComparison(facts, cur, prev)
    expect(rows.map(r => r.deptId)).toEqual(['design', 'video', UNASSIGNED_DEPT])
    expect(total.billedInr).toMatchObject({ current: 8000, previous: 4000, pct: 100 })
    expect(total.outflowInr).toMatchObject({ current: 3500, previous: 2000 })
  })
})
