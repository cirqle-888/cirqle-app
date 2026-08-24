import { describe, it, expect } from 'vitest'
import { stripCashbookAmounts } from './strip'

describe('stripCashbookAmounts — salary is a separate axis from cashbook amounts', () => {
  const entry = () => ({
    id: 'e1', amount: 5000, amount_inr: 5000,
    payroll_allocations: [{
      id: 'pa1', allocated_amount: 5000,
      payroll: { employee_id: 'x', net_salary: 42000, status: 'pending' },
    }],
  })

  it('withholds the salary from someone who can see cashbook amounts but not payroll', () => {
    const out: any = stripCashbookAmounts(entry(), true, false)
    expect(out.amount).toBe(5000)                                   // cashbook amounts kept
    expect(out.payroll_allocations[0].allocated_amount).toBe(5000)  // the allocation too
    expect(out.payroll_allocations[0].payroll.net_salary).toBeUndefined()
    expect(out.payroll_allocations[0].payroll.status).toBe('pending')
  })

  it('withholds both when neither is permitted', () => {
    const out: any = stripCashbookAmounts(entry(), false, false)
    expect(out.amount).toBeUndefined()
    expect(out.payroll_allocations[0].allocated_amount).toBeUndefined()
    expect(out.payroll_allocations[0].payroll.net_salary).toBeUndefined()
  })

  it('passes everything through when both are permitted', () => {
    const out: any = stripCashbookAmounts(entry(), true, true)
    expect(out.amount).toBe(5000)
    expect(out.payroll_allocations[0].payroll.net_salary).toBe(42000)
  })

  it('defaults the salary axis to the cashbook axis for existing callers', () => {
    const out: any = stripCashbookAmounts(entry(), true)
    expect(out.payroll_allocations[0].payroll.net_salary).toBe(42000)
  })
})
