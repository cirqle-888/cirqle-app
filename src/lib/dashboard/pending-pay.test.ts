import { describe, it, expect } from 'vitest'
import { pendingPayByEmployee } from './pending-pay'

describe('pendingPayByEmployee', () => {
  const rows = [
    { employee_id: 'a', month: 9, year: 2026, payslip_number: 'P2', net_salary: 1532, commission_earned: 1476, ownership_earned: 56 },
    { employee_id: 'a', month: 7, year: 2025, payslip_number: 'P1', net_salary: 1185.03, commission_earned: 1185.03 },
    { employee_id: 'a', month: 8, year: 2025, net_salary: 0 },
    { employee_id: 'b', month: 1, year: 2026, net_salary: 696 },
  ]
  const out = pendingPayByEmployee(rows)

  it('totals each person’s unpaid payslips, oldest first', () => {
    expect(out.a.slipsTotalInr).toBe(2717.03)
    expect(out.a.slips.map(s => `${s.year}-${s.month}`)).toEqual(['2025-7', '2026-9'])
    expect(out.b.slipsTotalInr).toBe(696)
  })
  it('splits a payslip into commission, ownership and the rest', () => {
    expect(out.a.slips[1]).toMatchObject({ commissionInr: 1476, ownershipInr: 56, otherInr: 0 })
  })
  it('counts ₹0 payslips without listing them', () => {
    expect(out.a.zeroSlips).toBe(1)
    expect(out.a.slips).toHaveLength(2)
  })
})
