import { describe, it, expect } from 'vitest'
import { buildEmployeeCostReport, type EmployeeCostSplitRaw } from './employee-costs'

function row(over: Partial<EmployeeCostSplitRaw>): EmployeeCostSplitRaw {
  return {
    employeeId: 'e1', employeeName: 'Asha', amountInr: 500,
    entryId: 'x1', entryDate: '2026-07-01', description: 'Photoshop seat',
    ...over,
  }
}

describe('buildEmployeeCostReport', () => {
  it('sums split amounts per employee, sorted descending', () => {
    const rows = buildEmployeeCostReport([
      row({ employeeId: 'e1', employeeName: 'Asha', amountInr: 500 }),
      row({ employeeId: 'e1', employeeName: 'Asha', amountInr: 300, entryId: 'x2' }),
      row({ employeeId: 'e2', employeeName: 'Bilal', amountInr: 1200, entryId: 'x3' }),
    ])
    expect(rows).toEqual([
      { employeeId: 'e2', employeeName: 'Bilal', totalInr: 1200, itemCount: 1 },
      { employeeId: 'e1', employeeName: 'Asha', totalInr: 800, itemCount: 2 },
    ])
  })

  it('returns [] for no rows', () => {
    expect(buildEmployeeCostReport([])).toEqual([])
  })
})
