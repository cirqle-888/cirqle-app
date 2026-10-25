import { describe, it, expect } from 'vitest'
import { departmentFlows, splitOverLines, UNASSIGNED_DEPT, type DeptDayFact } from './department-flows'

const fact = (f: Partial<DeptDayFact> & { date: string; deptId: string }): DeptDayFact =>
  ({ jobs: 0, jobValueInr: 0, billedInr: 0, inflowInr: 0, contributionPayInr: 0, ...f })

describe('departmentFlows', () => {
  const facts = [
    fact({ date: '2026-10-02', deptId: 'design', jobs: 3, jobValueInr: 3000, billedInr: 6000, inflowInr: 4000, contributionPayInr: 1000 }),
    fact({ date: '2026-10-03', deptId: 'video', jobs: 1, jobValueInr: 2000, billedInr: 2000, inflowInr: 1000, contributionPayInr: 500 }),
    fact({ date: '2026-10-04', deptId: UNASSIGNED_DEPT, inflowInr: 700 }),
    fact({ date: '2026-09-30', deptId: 'design', jobs: 9, billedInr: 99999 }),   // outside October
  ]
  const oct = { from: '2026-10-01', to: '2026-10-31' }

  it('measures job value, billed and inflow, and keeps unlinked cash Unassigned', () => {
    const rows = departmentFlows(facts, oct, 5500)
    const design = rows.find(r => r.deptId === 'design')!
    expect(design).toMatchObject({ jobs: 3, jobValueInr: 3000, billedInr: 6000, inflowInr: 4000 })
    expect(rows.find(r => r.deptId === UNASSIGNED_DEPT)!.inflowInr).toBe(700)
  })

  it('shares non-contribution outflow by billed, and adds up to the Outflow card', () => {
    const rows = departmentFlows(facts, oct, 5500)
    // pool = 5500 − 1500 = 4000 → design 3000, video 1000, unassigned 0
    expect(rows.find(r => r.deptId === 'design')).toMatchObject({ sharedCostInr: 3000, outflowInr: 4000, netInr: 0 })
    expect(rows.find(r => r.deptId === 'video')).toMatchObject({ sharedCostInr: 1000, outflowInr: 1500 })
    expect(rows.reduce((s, r) => s + r.outflowInr, 0)).toBe(5500)
    expect(rows.reduce((s, r) => s + r.inflowInr, 0)).toBe(5700)
  })

  it('lists Unassigned last', () => {
    expect(departmentFlows(facts, oct, 5500).at(-1)!.deptId).toBe(UNASSIGNED_DEPT)
  })

  it('puts the whole outflow on Unassigned when nothing was billed or done', () => {
    const rows = departmentFlows([fact({ date: '2026-10-02', deptId: UNASSIGNED_DEPT, inflowInr: 100 })], oct, 900)
    expect(rows).toEqual([expect.objectContaining({ deptId: UNASSIGNED_DEPT, outflowInr: 900, netInr: -800 })])
  })
})

describe('splitOverLines', () => {
  it('splits by line weight and sends an invoice with no lines to Unassigned', () => {
    expect(splitOverLines(1000, [{ deptId: 'a', amount: 30 }, { deptId: 'b', amount: 10 }, { deptId: 'a', amount: 10 }]))
      .toEqual([{ deptId: 'a', amountInr: 800 }, { deptId: 'b', amountInr: 200 }])
    expect(splitOverLines(50, [])).toEqual([{ deptId: UNASSIGNED_DEPT, amountInr: 50 }])
    expect(splitOverLines(-40, [{ deptId: 'a', amount: 1 }])).toEqual([{ deptId: 'a', amountInr: -40 }])
  })
})
