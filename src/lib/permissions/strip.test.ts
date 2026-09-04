import { describe, it, expect } from 'vitest'
import { stripCashbookAmounts, stripCashbookList, isSalaryCashbookEntry } from './strip'

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

describe('isSalaryCashbookEntry', () => {
  it('recognises the Salary category', () => {
    expect(isSalaryCashbookEntry({ category: { name: 'Salary' } })).toBe(true)
  })

  it('recognises a live payroll allocation even under a different category', () => {
    expect(isSalaryCashbookEntry({
      category: { name: 'Other' },
      payroll_allocations: [{ id: 'a', deleted_at: null }],
    })).toBe(true)
  })

  it('ignores a SOFT-DELETED payroll allocation', () => {
    // A reversed link is not a live one — nothing to hide any more.
    expect(isSalaryCashbookEntry({
      category: { name: 'Other' },
      payroll_allocations: [{ id: 'a', deleted_at: '2026-01-01' }],
    })).toBe(false)
  })

  it('is false for an ordinary entry', () => {
    expect(isSalaryCashbookEntry({ category: { name: 'Printing & Stationery' } })).toBe(false)
    expect(isSalaryCashbookEntry({})).toBe(false)
    expect(isSalaryCashbookEntry(null)).toBe(false)
  })
})

describe('stripCashbookList — salary rows are removed, not masked', () => {
  const salary = (i: number) => ({
    id: 's' + i, amount: 5000, amount_inr: 5000,
    category: { name: 'Salary' },
    description: `Salary — CQID00${i} — July 2026`,
  })
  const ordinary = { id: 'o1', amount: 300, amount_inr: 300, category: { name: 'Printing' } }

  it('drops salary rows entirely when the viewer lacks payroll visibility', () => {
    // The reported leak: a masked amount still left "Salary — CQID004 — July
    // 2026" on screen, naming a colleague and that they were paid that month.
    const out = stripCashbookList([salary(1), salary(2), ordinary], true, false)
    expect(out.map(e => e.id)).toEqual(['o1'])
  })

  it('keeps them when the viewer holds payroll visibility', () => {
    const out = stripCashbookList([salary(1), ordinary], true, true)
    expect(out.map(e => e.id)).toEqual(['s1', 'o1'])
  })

  it('still masks the ordinary entries’ amounts when cashbook.view_amounts is absent', () => {
    const out = stripCashbookList([ordinary], false, false)
    expect((out[0] as { amount?: number }).amount).toBeUndefined()
  })

  it('an all-salary list without payroll visibility comes back empty, not stripped-but-present', () => {
    const out = stripCashbookList([salary(1), salary(2)], true, false)
    expect(out).toEqual([])
  })
})
