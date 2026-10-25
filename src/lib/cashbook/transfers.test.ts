import { describe, it, expect } from 'vitest'
import {
  buildTransferLegs, convertBlocker, findTransferCounterparts, indexTransfers,
  transferFxDifference, transferLabel, validateTransfer,
  type ConvertCandidateRow, type TransferAccount,
} from './transfers'

const accounts: TransferAccount[] = [
  { id: 'hdfc', name: 'HDFC', currency: 'INR', is_active: true },
  { id: 'cash', name: 'Cash', currency: 'INR', is_active: true },
  { id: 'payoneer', name: 'Payoneer', currency: 'USD', is_active: true },
  { id: 'wise', name: 'Wise', currency: 'USD', is_active: true },
]
const rates = { INR: 1, USD: 84 }
const base = { from_account_id: 'hdfc', to_account_id: 'cash', amount: 5000, entry_date: '2026-10-16' }

describe('validateTransfer', () => {
  it('accepts a plain same-currency transfer', () => {
    expect(validateTransfer(base, accounts, rates)).toEqual([])
  })

  it('refuses the same account on both sides', () => {
    expect(validateTransfer({ ...base, to_account_id: 'hdfc' }, accounts, rates))
      .toContain('From and To must be different accounts')
  })

  it('refuses a zero or negative amount', () => {
    expect(validateTransfer({ ...base, amount: 0 }, accounts, rates)).toContain('Enter an amount greater than 0')
    expect(validateTransfer({ ...base, amount: -5 }, accounts, rates)).toContain('Enter an amount greater than 0')
  })

  it('requires a real date', () => {
    expect(validateTransfer({ ...base, entry_date: '' }, accounts, rates)).toContain('Date is required')
    expect(validateTransfer({ ...base, entry_date: '2026-02-30' }, accounts, rates)).toContain('Date is not a valid date')
  })

  it('asks for the amount received when the currencies differ', () => {
    expect(validateTransfer({ ...base, to_account_id: 'payoneer' }, accounts, rates))
      .toContain('Enter the amount received in USD')
  })

  it('refuses a currency with no exchange rate', () => {
    expect(validateTransfer({ ...base, from_account_id: 'payoneer', amount_received: 80000 }, accounts, { INR: 1 }))
      .toContain('No exchange rate for USD — add it in Settings')
  })
})

describe('buildTransferLegs', () => {
  it('writes equal INR legs for a same-currency transfer, with fallback descriptions', () => {
    const { outflow, inflow } = buildTransferLegs(base, accounts, rates)
    expect(outflow).toMatchObject({ type: 'outflow', bank_account_id: 'hdfc', amount: 5000, amount_inr: 5000, currency: 'INR', description: 'Transfer to Cash' })
    expect(inflow).toMatchObject({ type: 'inflow', bank_account_id: 'cash', amount: 5000, amount_inr: 5000, description: 'Transfer from HDFC' })
    expect(transferFxDifference([outflow, inflow])).toBe(0)
  })

  it('keeps a typed note on both legs', () => {
    const { outflow, inflow } = buildTransferLegs({ ...base, description: 'Cash withdrawal' }, accounts, rates)
    expect(outflow.description).toBe('Cash withdrawal')
    expect(inflow.description).toBe('Cash withdrawal')
  })

  it('converts a non-INR same-currency transfer at the book rate on both legs', () => {
    const { outflow, inflow } = buildTransferLegs({ ...base, from_account_id: 'payoneer', to_account_id: 'wise', amount: 100 }, accounts, rates)
    expect(outflow).toMatchObject({ currency: 'USD', amount: 100, exchange_rate: 84, amount_inr: 8400 })
    expect(inflow).toMatchObject({ currency: 'USD', amount: 100, amount_inr: 8400 })
  })

  it('stores each leg in its own currency and reports the INR gap as FX', () => {
    // 1,000 USD withdrawn from Payoneer, ₹83,200 lands in HDFC; book rate 84.
    const { outflow, inflow } = buildTransferLegs(
      { ...base, from_account_id: 'payoneer', to_account_id: 'hdfc', amount: 1000, amount_received: 83200 },
      accounts, rates)
    expect(outflow).toMatchObject({ currency: 'USD', amount: 1000, amount_inr: 84000 })
    expect(inflow).toMatchObject({ currency: 'INR', amount: 83200, amount_inr: 83200 })
    expect(transferFxDifference([outflow, inflow])).toBe(-800)
  })

  it('throws rather than build an invalid pair', () => {
    expect(() => buildTransferLegs({ ...base, amount: 0 }, accounts, rates)).toThrow()
  })
})

describe('transferLabel', () => {
  const rows = [
    { id: 'o', type: 'outflow', transfer_ref: 't', bank_account: { name: 'HDFC' } },
    { id: 'i', type: 'inflow', transfer_ref: 't', bank_account: { name: 'Cash' } },
  ]
  const index = indexTransfers(rows)

  it('reads From → To on both legs', () => {
    expect(transferLabel(rows[0], index)).toBe('Transfer: HDFC to Cash')
    expect(transferLabel(rows[1], index)).toBe('Transfer: HDFC to Cash')
  })

  it('still labels a leg whose partner is not loaded', () => {
    const lone = { id: 'x', type: 'inflow', transfer_ref: 'gone', bank_account: { name: 'Cash' } }
    expect(transferLabel(lone, indexTransfers([lone]))).toBe('Transfer: another account to Cash')
  })
})

describe('findTransferCounterparts', () => {
  const row = (over: Partial<ConvertCandidateRow>): ConvertCandidateRow =>
    ({ id: 'x', type: 'outflow', entry_date: '2026-06-11', amount_inr: 20000, bank_account_id: 'hdfc', ...over })
  const expense = row({ id: 'exp' })
  const income = row({ id: 'inc', type: 'inflow', bank_account_id: 'cash' })

  it('pairs an expense with the matching income on another account', () => {
    const others = [expense, income,
      row({ id: 'wrong-day', type: 'inflow', bank_account_id: 'cash', entry_date: '2026-06-12' }),
      row({ id: 'wrong-amount', type: 'inflow', bank_account_id: 'cash', amount_inr: 20000.5 }),
      row({ id: 'same-account', type: 'inflow' }),
      row({ id: 'same-type', bank_account_id: 'cash' })]
    expect(findTransferCounterparts(expense, others).map(r => r.id)).toEqual(['inc'])
  })

  it('never pairs entries that already mean something else', () => {
    expect(convertBlocker(row({ transfer_ref: 't' }))).toBe('Already a transfer')
    expect(convertBlocker(row({ reversal_of: 'r' }))).toBe('A reversal cannot become a transfer')
    expect(convertBlocker(row({ allocations: [{ deleted_at: null }] }))).toBe('The entry is allocated to an invoice')
    expect(convertBlocker(row({ payroll_allocations: [{ deleted_at: null }] }))).toBe('The entry is allocated to a payslip')
    expect(convertBlocker(row({ allocations: [{ deleted_at: '2026-01-01' }] }))).toBeNull()
    expect(convertBlocker(row({ id: 'r' }), new Set(['r']))).toBe('This entry has been reversed')
    expect(findTransferCounterparts(expense, [income], new Set(['inc']))).toEqual([])
  })
})
