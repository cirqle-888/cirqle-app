import { describe, it, expect } from 'vitest'
import {
  buildDepartmentPnl, buildEmployeeEarningsMatrix,
  type DepartmentInput, type EmployeeEarningCell,
} from './department-pnl'
import { composeProfit } from './profit'

const dept = (
  departmentId: string,
  revenueInr: number,
  directLabourInr: number,
  taskCount = 1,
): DepartmentInput => ({
  departmentId,
  departmentName: departmentId,
  revenueInr,
  directLabourInr,
  taskCount,
})

describe('buildDepartmentPnl', () => {
  it('measures contribution margin from actuals, before any allocation', () => {
    const { rows } = buildDepartmentPnl(
      [dept('video', 100_000, 40_000)],
      { allocatableOpexInr: 0, baseSalariesInr: 0 },
    )
    expect(rows[0].contributionMarginInr).toBe(60_000)
    expect(rows[0].contributionMarginPct).toBe(60)
  })

  it('apportions both pools by revenue share', () => {
    const { rows } = buildDepartmentPnl(
      [dept('a', 75_000, 0), dept('b', 25_000, 0)],
      { allocatableOpexInr: 20_000, baseSalariesInr: 40_000 },
    )
    const a = rows.find(r => r.departmentId === 'a')!
    const b = rows.find(r => r.departmentId === 'b')!
    expect(a.allocatedOpexInr).toBe(15_000)
    expect(b.allocatedOpexInr).toBe(5_000)
    expect(a.allocatedSalariesInr).toBe(30_000)
    expect(b.allocatedSalariesInr).toBe(10_000)
    expect(a.revenueSharePct).toBe(75)
  })

  it('RECONCILES to the profit engine exactly', () => {
    // The whole point: Σ operating results must equal
    // revenue − contribution − baseSalaries − expenses.
    const inputs = [dept('a', 61_111.11, 20_000), dept('b', 22_222.22, 9_999.99), dept('c', 16_666.67, 3_333.33)]
    const allocatableOpexInr = 17_777.77
    const baseSalariesInr = 33_333.33

    const { reconciliationInr } = buildDepartmentPnl(inputs, { allocatableOpexInr, baseSalariesInr })

    const engineProfit = composeProfit({
      revenueInr: inputs.reduce((s, i) => s + i.revenueInr, 0),
      contributionInr: inputs.reduce((s, i) => s + i.directLabourInr, 0),
      baseSalariesInr,
      expensesInr: allocatableOpexInr,
    })
    expect(reconciliationInr).toBe(engineProfit)
  })

  it('allocates the pools to the paise even on an indivisible split', () => {
    const { totals, allocatableOpexInr } = buildDepartmentPnl(
      [dept('a', 1, 0), dept('b', 1, 0), dept('c', 1, 0)],
      { allocatableOpexInr: 100, baseSalariesInr: 0 },
    )
    expect(totals.allocatedOpexInr).toBe(allocatableOpexInr)
  })

  it('charges no overhead to a department that billed nothing', () => {
    // Charging rent to a discipline with no revenue would manufacture a loss
    // out of an accounting choice rather than reporting one.
    const { rows } = buildDepartmentPnl(
      [dept('earner', 100_000, 0), dept('idle', 0, 0)],
      { allocatableOpexInr: 10_000, baseSalariesInr: 10_000 },
    )
    const idle = rows.find(r => r.departmentId === 'idle')!
    expect(idle.allocatedOpexInr).toBe(0)
    expect(idle.allocatedSalariesInr).toBe(0)
    expect(idle.operatingResultInr).toBe(0)
  })

  it('keeps a department that loses money on its own work distinguishable', () => {
    const { rows } = buildDepartmentPnl(
      [dept('bleeding', 10_000, 14_000)],
      { allocatableOpexInr: 0, baseSalariesInr: 0 },
    )
    // Negative BEFORE allocation — a real problem, not an apportionment artefact.
    expect(rows[0].contributionMarginInr).toBe(-4_000)
  })

  it('sorts by revenue, largest first', () => {
    const { rows } = buildDepartmentPnl(
      [dept('small', 1_000, 0), dept('big', 90_000, 0), dept('mid', 20_000, 0)],
      { allocatableOpexInr: 0, baseSalariesInr: 0 },
    )
    expect(rows.map(r => r.departmentId)).toEqual(['big', 'mid', 'small'])
  })

  it('totals every column and never divides by zero on an empty period', () => {
    const { rows, totals, reconciliationInr } = buildDepartmentPnl(
      [], { allocatableOpexInr: 5_000, baseSalariesInr: 5_000 },
    )
    expect(rows).toEqual([])
    expect(totals.revenueInr).toBe(0)
    expect(totals.contributionMarginPct).toBe(0)
    expect(totals.operatingMarginPct).toBe(0)
    expect(reconciliationInr).toBe(0)
  })

  it('totals are the sum of the rows', () => {
    const { rows, totals } = buildDepartmentPnl(
      [dept('a', 60_000, 20_000, 3), dept('b', 40_000, 15_000, 2)],
      { allocatableOpexInr: 10_000, baseSalariesInr: 20_000 },
    )
    expect(totals.revenueInr).toBe(100_000)
    expect(totals.directLabourInr).toBe(35_000)
    expect(totals.taskCount).toBe(5)
    expect(totals.operatingResultInr).toBe(
      Math.round(rows.reduce((s, r) => s + r.operatingResultInr, 0) * 100) / 100,
    )
  })
})

const cell = (
  employeeId: string,
  departmentId: string,
  earningsInr: number,
  taskCount = 1,
): EmployeeEarningCell => ({
  employeeId,
  employeeCqid: `CQID-${employeeId}`,
  departmentId,
  earningsInr,
  taskCount,
})

describe('buildEmployeeEarningsMatrix', () => {
  it('pivots one person across several departments', () => {
    const { rows } = buildEmployeeEarningsMatrix([
      cell('ann', 'video', 5_000, 2),
      cell('ann', 'social', 3_000, 4),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].byDepartment).toEqual({ video: 5_000, social: 3_000 })
    expect(rows[0].taskCountByDepartment).toEqual({ video: 2, social: 4 })
    expect(rows[0].totalInr).toBe(8_000)
    expect(rows[0].totalTaskCount).toBe(6)
  })

  it('accumulates repeated cells for the same person and department', () => {
    const { rows } = buildEmployeeEarningsMatrix([
      cell('ann', 'video', 1_000, 1), cell('ann', 'video', 250.55, 1),
    ])
    expect(rows[0].byDepartment.video).toBe(1_250.55)
    expect(rows[0].totalTaskCount).toBe(2)
  })

  it('DEPARTMENT TOTALS tie back to the statement direct-labour column', () => {
    // The two views must never disagree about the same rupees.
    const cells = [
      cell('ann', 'video', 5_000), cell('bob', 'video', 2_500),
      cell('ann', 'social', 1_500), cell('cat', 'social', 500),
    ]
    const { departmentTotals, grandTotalInr } = buildEmployeeEarningsMatrix(cells)
    expect(departmentTotals.video).toBe(7_500)
    expect(departmentTotals.social).toBe(2_000)

    const statement = buildDepartmentPnl(
      [dept('video', 20_000, departmentTotals.video), dept('social', 10_000, departmentTotals.social)],
      { allocatableOpexInr: 0, baseSalariesInr: 0 },
    )
    for (const r of statement.rows) {
      expect(r.directLabourInr).toBe(departmentTotals[r.departmentId])
    }
    expect(grandTotalInr).toBe(statement.totals.directLabourInr)
  })

  it('sorts by total earned, biggest first, and computes share', () => {
    const { rows } = buildEmployeeEarningsMatrix([
      cell('small', 'video', 1_000), cell('big', 'video', 7_000), cell('mid', 'video', 2_000),
    ])
    expect(rows.map(r => r.employeeId)).toEqual(['big', 'mid', 'small'])
    expect(rows[0].sharePct).toBe(70)
    expect(rows.reduce((s, r) => s + r.sharePct, 0)).toBeCloseTo(100, 6)
  })

  it('leaves a department key absent when a person did none of that work', () => {
    const { rows } = buildEmployeeEarningsMatrix([cell('ann', 'video', 5_000)])
    expect(rows[0].byDepartment.social).toBeUndefined()
  })

  it('handles an empty period without dividing by zero', () => {
    const m = buildEmployeeEarningsMatrix([])
    expect(m.rows).toEqual([])
    expect(m.grandTotalInr).toBe(0)
    expect(m.departmentTotals).toEqual({})
  })
})
