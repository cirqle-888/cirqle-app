import { describe, it, expect } from 'vitest'
import { buildReversalRow, reverseBlocker, reversedIdsOf, type ReversibleEntry } from './reversal'

const salary: ReversibleEntry = {
  id: 'sal-1', type: 'outflow', bank_account_id: 'hdfc', category_id: 'cat-salary',
  client_id: null, employee_id: 'emp-1', scope: 'company', currency: 'INR',
  amount: 5353, exchange_rate: 1, amount_inr: 5353, rate_source: 'manual',
  rate_date: '2026-10-01', entry_date: '2026-10-01', description: 'Salary — CQID001 — September',
  reference: 'NEFT123', invoice_id: null,
} as ReversibleEntry & { invoice_id: null }

describe('buildReversalRow', () => {
  it('is the opposite type, same account and category, linked to the original', () => {
    const r = buildReversalRow(salary, { entry_date: '2026-10-03', note: 'Account closed' })
    expect(r).toMatchObject({
      type: 'inflow', bank_account_id: 'hdfc', category_id: 'cat-salary', employee_id: 'emp-1',
      amount: 5353, amount_inr: 5353, entry_date: '2026-10-03', reversal_of: 'sal-1',
      reference: 'NEFT123', description: 'Returned: Salary — CQID001 — September — Account closed',
    })
  })

  it('reverses a foreign receipt at its ORIGINAL rate so the two net to zero', () => {
    const r = buildReversalRow(
      { ...salary, id: 'usd-1', type: 'inflow', currency: 'USD', amount: 100, exchange_rate: 83.1, amount_inr: 8310 },
      { entry_date: '2026-10-20' })
    expect(r).toMatchObject({ type: 'outflow', currency: 'USD', amount: 100, exchange_rate: 83.1, amount_inr: 8310 })
  })

  it('never carries an invoice_id, which would auto-allocate the full amount', () => {
    expect(buildReversalRow({ ...salary, invoice_id: 'inv-1' } as any, { entry_date: '2026-10-03' }).invoice_id).toBeNull()
  })
})

describe('reverseBlocker', () => {
  it('allows an ordinary entry', () => {
    expect(reverseBlocker(salary, { accountCode: 'opex.salaries' })).toBeNull()
  })

  it('refuses transfers, reversals, and entries already reversed', () => {
    expect(reverseBlocker({ ...salary, transfer_ref: 't' })).toMatch(/transfer/)
    expect(reverseBlocker({ ...salary, reversal_of: 'x' })).toMatch(/itself a reversal/)
    expect(reverseBlocker(salary, { reversedIds: new Set(['sal-1']) })).toBe('This entry has already been reversed')
  })

  it('sends Credit Given / Credit Return to the credit ledger', () => {
    expect(reverseBlocker(salary, { accountCode: 'financial.credit_given' })).toMatch(/Payroll → Credits/)
    expect(reverseBlocker(salary, { accountCode: 'financial.credit_return' })).toMatch(/Payroll → Credits/)
  })

  it('refuses an expense already billed on an issued invoice', () => {
    expect(reverseBlocker(salary, { billedOnIssuedInvoice: 'INV-2610-057' })).toMatch(/INV-2610-057/)
  })
})

describe('reversedIdsOf', () => {
  it('collects originals with a live reversal only', () => {
    expect([...reversedIdsOf([
      { reversal_of: 'a' }, { reversal_of: 'b', deleted_at: '2026-10-01' }, { reversal_of: null },
    ])]).toEqual(['a'])
  })
})
