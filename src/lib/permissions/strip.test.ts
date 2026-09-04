import { describe, it, expect } from 'vitest'
import {
  isSalaryCashbookEntry,
  stripCashbookAmounts,
  stripCashbookList,
  stripInvoiceAmounts,
  stripPayrollAmounts,
} from './strip'

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

/**
 * The four gaps found in the 2026-09-04 audit.
 *
 * Every one had the same shape: the strip named columns that DO NOT EXIST
 * (`line_total`, `deductions_total`, `advances_total`, `credits_total`) while
 * the real ones went straight through. A no-op that reads as thorough is worse
 * than no strip at all, because nobody looks at it twice.
 *
 * These assert against the column names the tables actually have.
 */
describe('audit 2026-09-04 — the columns that really exist are the ones removed', () => {
  it('an invoice line loses its total, not just a field named amount', () => {
    // Evidence: a Task Manager without view_line_pricing saw "2 × — = ₹600.00".
    // The dash was unit_price, correctly stripped. The ₹600.00 was `total`.
    const out = stripInvoiceAmounts(
      { id: 'i1', items: [{ id: 'l1', unit_price: 300, total: 600, description: 'x' }] },
      { amounts: true, linePricing: false },
    )
    const line = (out.items as Record<string, unknown>[])[0]
    expect(line).not.toHaveProperty('total')
    expect(line).not.toHaveProperty('unit_price')
    expect(line.description).toBe('x')   // non-money survives
  })

  it('an invoice loses its carried-forward balance', () => {
    const out = stripInvoiceAmounts(
      { id: 'i1', total_amount: 100, previous_balance: 250 },
      { amounts: false, linePricing: false },
    )
    expect(out).not.toHaveProperty('previous_balance')
  })

  it('payroll loses the deduction columns the table actually has', () => {
    const out = stripPayrollAmounts(
      { id: 'p1', net_salary: 1000, advances_deducted: 200, other_deductions: 50, month: 8 },
      false,
    )
    expect(out).not.toHaveProperty('advances_deducted')
    expect(out).not.toHaveProperty('other_deductions')
    expect(out.month).toBe(8)
  })

  it('a cashbook entry loses the rebill cushion, which is the margin', () => {
    const out = stripCashbookAmounts(
      { id: 'c1', amount: 2330, markup_value: 750, markup_amount: 750, description: 'print' },
      false,
    )
    expect(out).not.toHaveProperty('markup_value')
    expect(out).not.toHaveProperty('markup_amount')
    expect(out.description).toBe('print')
  })

  it('none of it happens to someone who IS permitted', () => {
    const inv = { id: 'i1', previous_balance: 250, items: [{ id: 'l1', unit_price: 300, total: 600 }] }
    expect(stripInvoiceAmounts(inv, { amounts: true, linePricing: true })).toEqual(inv)
    const pay = { id: 'p1', advances_deducted: 200, other_deductions: 50 }
    expect(stripPayrollAmounts(pay, true)).toEqual(pay)
    const cb = { id: 'c1', amount: 2330, markup_value: 750 }
    expect(stripCashbookAmounts(cb, true)).toEqual(cb)
  })
})
