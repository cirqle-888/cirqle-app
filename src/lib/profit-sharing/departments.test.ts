import { describe, it, expect } from 'vitest'
import { departmentView, NO_DEPARTMENT } from './departments'

const deductions = { operatingPaymentsInr: 270000, remunerationInr: 320000, extraPayInr: 0, deviceCostsInr: 0, passthroughWriteoffsInr: 0, adWriteoffsInr: 0 }

describe('department view (analysis only)', () => {
  const v = departmentView({
    ownRevenueByInvoice: [{ invoiceId: 'A', amountInr: 20000 }, { invoiceId: 'B', amountInr: 700000 }, { invoiceId: 'B', amountInr: -10000 }],
    invoiceLines: [
      { invoiceId: 'A', deptId: 'ads', amount: 20000 },
      { invoiceId: 'B', deptId: 'design', amount: 500000 },
      { invoiceId: 'B', deptId: 'video', amount: 200000 },
    ],
    contributions: [
      { employeeId: 'e1', taskId: 't1', deptId: 'design', earningsInr: 90000 },
      { employeeId: 'e2', taskId: 't2', deptId: 'design', earningsInr: 30000 },
      { employeeId: 'e2', taskId: 't3', deptId: 'video', earningsInr: 40000 },
    ],
    assignments: [{ employeeId: 'e3', taskId: 't3', deptId: 'video' }, { employeeId: 'e2', taskId: 't3', deptId: 'video' }],
    deductions,
    profitInr: 120000,
  })
  const row = (id: string) => v.departments.find(d => d.deptId === id)!

  it('splits own revenue by each invoice’s lines, refunds included', () => {
    expect(row('ads').ownRevenueInr).toBe(20000)
    expect(row('design').ownRevenueInr).toBe(492857.14)
    expect(row('video').ownRevenueInr).toBe(197142.86)
  })

  it('measures contribution pay, and apportions the rest by revenue', () => {
    expect(row('design').contributionPayInr).toBe(120000)
    expect(v.sharedPoolInr).toBe(590000 - 160000)
  })

  it('always adds back up to the cash profit, to the paisa', () => {
    expect(v.reconciliationInr).toBe(0)
  })

  it('shows each person per department, with roles that earned nothing', () => {
    const e2video = v.employees.find(e => e.employeeId === 'e2' && e.deptId === 'video')!
    expect(e2video).toMatchObject({ earningsInr: 40000, tasks: 1, shareOfDeptPay: 1, roleOnlyTasks: 0 })
    expect(v.employees.find(e => e.employeeId === 'e3')).toMatchObject({ deptId: 'video', earningsInr: 0, roleOnlyTasks: 1 })
    expect(v.employees.find(e => e.employeeId === 'e1')!.shareOfDeptPay).toBe(0.75)
  })

  it('puts revenue with no invoice lines under no department, and still reconciles', () => {
    const w = departmentView({ ownRevenueByInvoice: [{ invoiceId: null, amountInr: 5000 }], invoiceLines: [], contributions: [], assignments: [], deductions: { ...deductions, operatingPaymentsInr: 1000, remunerationInr: 0 }, profitInr: 4000 })
    expect(w.departments).toEqual([expect.objectContaining({ deptId: NO_DEPARTMENT, ownRevenueInr: 5000, sharedCostInr: 1000, resultInr: 4000 })])
    expect(w.reconciliationInr).toBe(0)
  })
})
