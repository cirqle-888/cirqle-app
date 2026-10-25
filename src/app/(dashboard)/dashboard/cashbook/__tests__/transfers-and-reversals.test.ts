/* eslint-disable @typescript-eslint/no-explicit-any -- a test double for the untyped Supabase query builder: rows are whatever each test seeds. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryDb, CASHBOOK_RELATIONS, cashbookTriggers, oneLiveReversal, type MemoryDbOptions } from './memory-db'

// ── Mocks ────────────────────────────────────────────────────────────────────

let db: MemoryDb
const draftSyncCalls: { entryId: string; opts?: any }[] = []
const fundingReleased: string[] = []

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/permissions/check', () => ({
  requirePermission: () => Promise.resolve({ ok: true }),
  requireReadPermission: () => Promise.resolve({ ok: true }),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => db.client() }))
vi.mock('@/lib/sync/integrity', () => ({
  syncDraftInvoiceExpenses: (entryId: string, opts?: any) => { draftSyncCalls.push({ entryId, opts }); return Promise.resolve() },
}))
vi.mock('@/lib/cashbook/release-funding', () => ({
  releaseEntryFunding: (_admin: any, entryId: string) => { fundingReleased.push(entryId); return Promise.resolve() },
}))
vi.mock('@/lib/fx/sync', () => ({ fetchRates: vi.fn() }))
vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn() }))

import { insertTransfer, updateTransfer, convertToTransfer } from '../transfer-actions'
import { reverseCashbookEntry } from '../reversal-actions'
import { softDeleteCashbookEntry } from '../actions'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ACCOUNTS = [
  { id: 'hdfc', name: 'HDFC', currency: 'INR', is_active: true },
  { id: 'cash', name: 'Cash', currency: 'INR', is_active: true },
  { id: 'payoneer', name: 'Payoneer', currency: 'USD', is_active: true },
]
const CATEGORIES = [
  { id: 'cat-salary', name: 'Salary', type: 'outflow', account_code: 'opex.salaries' },
  { id: 'cat-invoice', name: 'Invoice', type: 'inflow', account_code: 'revenue.services' },
  { id: 'cat-credit', name: 'Credit Given', type: 'outflow', account_code: 'financial.credit_given' },
]
const entry = (over: Record<string, any>) => ({
  type: 'outflow', bank_account_id: 'hdfc', category_id: null, client_id: null, scope: 'company',
  currency: 'INR', amount: 0, exchange_rate: 1, amount_inr: 0, rate_source: 'manual',
  rate_date: '2026-10-01', entry_date: '2026-10-01', description: '', reference: null,
  transfer_ref: null, reversal_of: null, deleted_at: null, ...over,
})

function makeDb(seed: Record<string, any[]> = {}, opts: Partial<MemoryDbOptions> = {}) {
  db = new MemoryDb({
    bank_accounts: ACCOUNTS,
    cashbook_categories: CATEGORIES,
    exchange_rates: [{ currency: 'USD', rate_to_inr: 84 }],
    cashbook_entries: [],
    cashbook_invoice_allocations: [],
    cashbook_payroll_allocations: [],
    invoice_expense_items: [],
    bank_statement_matches: [],
    invoices: [],
    payroll: [],
    ...seed,
  }, { relations: CASHBOOK_RELATIONS, triggers: cashbookTriggers, beforeInsert: oneLiveReversal, ...opts })
  return db
}

/** A paid payslip: a ₹5,353 salary entry allocated in full. */
function paidSalary() {
  return makeDb({
    cashbook_entries: [entry({ id: 'sal', category_id: 'cat-salary', amount: 5353, amount_inr: 5353, description: 'Salary — CQID001 — September' })],
    cashbook_payroll_allocations: [{ id: 'pa1', cashbook_entry_id: 'sal', payroll_id: 'pay1', allocated_amount: 5353, deleted_at: null, released_by_entry_id: null }],
    payroll: [{ id: 'pay1', net_salary: 5353, status: 'paid' }],
  })
}

/** An invoice paid by a ₹10,000 receipt. */
function paidInvoice() {
  return makeDb({
    cashbook_entries: [entry({ id: 'rcpt', type: 'inflow', category_id: 'cat-invoice', client_id: 'cl1', amount: 10000, amount_inr: 10000, description: 'Payment for INV-2610-057' })],
    cashbook_invoice_allocations: [{ id: 'ia1', cashbook_entry_id: 'rcpt', invoice_id: 'inv1', allocated_amount: 10000, deleted_at: null, released_by_entry_id: null }],
    invoices: [{ id: 'inv1', invoice_number: 'INV-2610-057', total_amount: 10000, paid_amount: 10000, status: 'paid' }],
  })
}

const live = (table = 'cashbook_entries') => db.rows(table).filter(r => !r.deleted_at)

beforeEach(() => {
  draftSyncCalls.length = 0
  fundingReleased.length = 0
})

// ── Transfers ────────────────────────────────────────────────────────────────

describe('insertTransfer', () => {
  it('writes both legs in ONE insert, sharing a transfer id, with no category', async () => {
    makeDb()
    const res = await insertTransfer({ from_account_id: 'hdfc', to_account_id: 'cash', amount: 20000, entry_date: '2026-10-16' })
    expect(res.ok).toBe(true)

    const inserts = db.log.filter(l => l.table === 'cashbook_entries' && l.op === 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].ids).toHaveLength(2)

    const [a, b] = live()
    expect(a.transfer_ref).toBeTruthy()
    expect(a.transfer_ref).toBe(b.transfer_ref)
    expect([a.type, b.type].sort()).toEqual(['inflow', 'outflow'])
    expect(a.category_id).toBeNull()
    expect(b.category_id).toBeNull()
    expect(res.data!.outflow.bank_account_id).toBe('hdfc')
    expect(res.data!.inflow.bank_account_id).toBe('cash')
  })

  it('validates on the server, not only in the form', async () => {
    makeDb()
    const same = await insertTransfer({ from_account_id: 'hdfc', to_account_id: 'hdfc', amount: 100, entry_date: '2026-10-16' })
    expect(same).toMatchObject({ ok: false, error: 'From and To must be different accounts' })
    const zero = await insertTransfer({ from_account_id: 'hdfc', to_account_id: 'cash', amount: 0, entry_date: '2026-10-16' })
    expect(zero.ok).toBe(false)
    const noDate = await insertTransfer({ from_account_id: 'hdfc', to_account_id: 'cash', amount: 10, entry_date: '' })
    expect(noDate).toMatchObject({ ok: false, error: 'Date is required' })
    expect(db.rows('cashbook_entries')).toHaveLength(0)
  })

  it('stores a cross-currency transfer in each account’s own currency', async () => {
    makeDb()
    const res = await insertTransfer({ from_account_id: 'payoneer', to_account_id: 'hdfc', amount: 1000, amount_received: 83200, entry_date: '2026-10-16' })
    expect(res.ok).toBe(true)
    expect(res.data!.outflow).toMatchObject({ currency: 'USD', amount: 1000, amount_inr: 84000 })
    expect(res.data!.inflow).toMatchObject({ currency: 'INR', amount: 83200, amount_inr: 83200 })
  })
})

describe('deleting a transfer', () => {
  it('deletes BOTH legs when either one is deleted', async () => {
    makeDb()
    const res = await insertTransfer({ from_account_id: 'hdfc', to_account_id: 'cash', amount: 500, entry_date: '2026-10-16' })
    const del = await softDeleteCashbookEntry(res.data!.inflow.id)
    expect(del.ok).toBe(true)
    expect(del.data!.deletedIds.sort()).toEqual([res.data!.outflow.id, res.data!.inflow.id].sort())
    expect(live()).toHaveLength(0)
    // One statement, both rows, the same timestamp.
    const [a, b] = db.rows('cashbook_entries')
    expect(a.deleted_at).toBe(b.deleted_at)
  })

  it('leaves unrelated entries alone', async () => {
    makeDb({ cashbook_entries: [entry({ id: 'other', amount: 3, amount_inr: 3 })] })
    const res = await insertTransfer({ from_account_id: 'hdfc', to_account_id: 'cash', amount: 500, entry_date: '2026-10-16' })
    await softDeleteCashbookEntry(res.data!.outflow.id)
    expect(live().map(r => r.id)).toEqual(['other'])
  })
})

describe('updateTransfer', () => {
  it('rewrites both legs together', async () => {
    makeDb()
    const res = await insertTransfer({ from_account_id: 'hdfc', to_account_id: 'cash', amount: 500, entry_date: '2026-10-16' })
    const ref = res.data!.outflow.transfer_ref
    const up = await updateTransfer(ref, { from_account_id: 'hdfc', to_account_id: 'cash', amount: 750, entry_date: '2026-10-15', description: 'ATM' })
    expect(up.ok).toBe(true)
    for (const leg of live()) {
      expect(leg).toMatchObject({ amount: 750, amount_inr: 750, entry_date: '2026-10-15', description: 'ATM', transfer_ref: ref })
    }
  })

  it('refuses to change the money while a leg is matched to a bank statement line', async () => {
    makeDb()
    const res = await insertTransfer({ from_account_id: 'hdfc', to_account_id: 'cash', amount: 500, entry_date: '2026-10-16' })
    db.rows('bank_statement_matches').push({ id: 'm1', cashbook_entry_id: res.data!.outflow.id })
    const ref = res.data!.outflow.transfer_ref
    const up = await updateTransfer(ref, { from_account_id: 'hdfc', to_account_id: 'cash', amount: 900, entry_date: '2026-10-16' })
    expect(up.ok).toBe(false)
    expect(up.error).toMatch(/bank statement/)
    expect(live().every(l => l.amount === 500)).toBe(true)

    // A note-only edit is still fine.
    const note = await updateTransfer(ref, { from_account_id: 'hdfc', to_account_id: 'cash', amount: 500, entry_date: '2026-10-16', description: 'Petty cash' })
    expect(note.ok).toBe(true)
  })
})

describe('convertToTransfer', () => {
  it('pairs a legacy expense and income into one transfer', async () => {
    makeDb({ cashbook_entries: [
      entry({ id: 'out', category_id: 'cat-salary', client_id: 'cl9', amount: 20000, amount_inr: 20000, entry_date: '2026-06-11', description: 'To cash' }),
      entry({ id: 'in', type: 'inflow', bank_account_id: 'cash', category_id: 'cat-invoice', amount: 20000, amount_inr: 20000, entry_date: '2026-06-11', description: 'From HDFC' }),
    ] })
    const res = await convertToTransfer('out', 'in')
    expect(res.ok).toBe(true)
    const [a, b] = live()
    expect(a.transfer_ref).toBe(res.data!.transferRef)
    expect(b.transfer_ref).toBe(res.data!.transferRef)
    expect(a).toMatchObject({ category_id: null, client_id: null, description: 'To cash' })
    expect(b).toMatchObject({ category_id: null, description: 'From HDFC' })
  })

  it('refuses entries that do not match, or that are allocated', async () => {
    makeDb({
      cashbook_entries: [
        entry({ id: 'out', amount: 20000, amount_inr: 20000, entry_date: '2026-06-11' }),
        entry({ id: 'in', type: 'inflow', bank_account_id: 'cash', amount: 19999, amount_inr: 19999, entry_date: '2026-06-11' }),
        entry({ id: 'sal', category_id: 'cat-salary', amount: 19999, amount_inr: 19999, entry_date: '2026-06-11' }),
      ],
      cashbook_payroll_allocations: [{ id: 'pa', cashbook_entry_id: 'sal', payroll_id: 'p', allocated_amount: 19999, deleted_at: null }],
    })
    expect((await convertToTransfer('out', 'in')).error).toBe('The two entries are for different amounts')
    expect((await convertToTransfer('sal', 'in')).error).toMatch(/allocated to a payslip/)
    expect(live().every(r => !r.transfer_ref)).toBe(true)
  })
})

// ── Reversals ────────────────────────────────────────────────────────────────

describe('reverseCashbookEntry — salary', () => {
  it('records the return and puts the payslip back to pending', async () => {
    paidSalary()
    const res = await reverseCashbookEntry('sal', { entry_date: '2026-10-03', note: 'NEFT returned' })
    expect(res.ok).toBe(true)
    expect(res.data!.released).toEqual({ invoices: 0, payslips: 1 })

    const reversal = db.rows('cashbook_entries').find(r => r.reversal_of === 'sal')!
    expect(reversal).toMatchObject({
      type: 'inflow', bank_account_id: 'hdfc', category_id: 'cat-salary',
      amount_inr: 5353, entry_date: '2026-10-03', invoice_id: null,
    })
    expect(db.get('cashbook_payroll_allocations', 'pa1')).toMatchObject({ released_by_entry_id: reversal.id })
    expect(db.get('cashbook_payroll_allocations', 'pa1')!.deleted_at).toBeTruthy()
    expect(db.get('payroll', 'pay1')!.status).toBe('pending')
    // The original stays: the payment happened, the bank shows both lines.
    expect(db.get('cashbook_entries', 'sal')!.deleted_at).toBeNull()
  })

  it('refuses a second reversal of the same entry', async () => {
    paidSalary()
    await reverseCashbookEntry('sal', { entry_date: '2026-10-03' })
    const again = await reverseCashbookEntry('sal', { entry_date: '2026-10-04' })
    expect(again).toMatchObject({ ok: false, error: 'This entry has already been reversed' })
    expect(db.rows('cashbook_entries').filter(r => r.reversal_of === 'sal')).toHaveLength(1)
  })

  it('refuses a return dated before the payment', async () => {
    paidSalary()
    const res = await reverseCashbookEntry('sal', { entry_date: '2026-09-30' })
    expect(res.ok).toBe(false)
    expect(db.get('payroll', 'pay1')!.status).toBe('paid')
  })

  it('deleting the reversal undoes it: the payslip is paid again', async () => {
    paidSalary()
    const res = await reverseCashbookEntry('sal', { entry_date: '2026-10-03' })
    const del = await softDeleteCashbookEntry(res.data!.reversal.id)
    expect(del.data!.deletedIds).toEqual([res.data!.reversal.id])
    expect(db.get('cashbook_payroll_allocations', 'pa1')).toMatchObject({ deleted_at: null, released_by_entry_id: null })
    expect(db.get('payroll', 'pay1')!.status).toBe('paid')
    expect(db.get('cashbook_entries', 'sal')!.deleted_at).toBeNull()
  })

  it('deleting the original takes its reversal with it', async () => {
    paidSalary()
    const res = await reverseCashbookEntry('sal', { entry_date: '2026-10-03' })
    const del = await softDeleteCashbookEntry('sal')
    expect(del.data!.deletedIds.sort()).toEqual(['sal', res.data!.reversal.id].sort())
    expect(live()).toHaveLength(0)
    expect(db.get('payroll', 'pay1')!.status).toBe('pending')
  })
})

describe('reverseCashbookEntry — invoice payment', () => {
  it('reduces the invoice back to unpaid and keeps the category for netting', async () => {
    paidInvoice()
    const res = await reverseCashbookEntry('rcpt', { entry_date: '2026-10-05' })
    expect(res.ok).toBe(true)
    expect(res.data!.released).toEqual({ invoices: 1, payslips: 0 })
    expect(db.get('invoices', 'inv1')).toMatchObject({ paid_amount: 0, status: 'sent' })

    const reversal = db.rows('cashbook_entries').find(r => r.reversal_of === 'rcpt')!
    expect(reversal).toMatchObject({ type: 'outflow', category_id: 'cat-invoice', client_id: 'cl1', amount_inr: 10000 })
    // A client-tagged outflow is normally rebilled onto the client's draft
    // invoice; the reversal must not be. Only the ORIGINAL is synced, as released.
    expect(draftSyncCalls).toEqual([{ entryId: 'rcpt', opts: { released: true } }])
  })
})

describe('reverseCashbookEntry — refusals', () => {
  it('refuses Credit Given entries, which belong to the credit ledger', async () => {
    makeDb({ cashbook_entries: [entry({ id: 'cr', category_id: 'cat-credit', amount: 5000, amount_inr: 5000 })] })
    const res = await reverseCashbookEntry('cr', { entry_date: '2026-10-03' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Payroll → Credits/)
    expect(db.rows('cashbook_entries')).toHaveLength(1)
  })

  it('refuses an expense already billed on an issued invoice', async () => {
    makeDb({
      cashbook_entries: [entry({ id: 'exp', client_id: 'cl1', amount: 900, amount_inr: 900 })],
      invoice_expense_items: [{ id: 'x1', cashbook_entry_id: 'exp', invoice_id: 'inv9' }],
      invoices: [{ id: 'inv9', invoice_number: 'INV-2610-099', status: 'sent', total_amount: 900, paid_amount: 0 }],
    })
    const res = await reverseCashbookEntry('exp', { entry_date: '2026-10-03' })
    expect(res.error).toMatch(/INV-2610-099/)
  })

  it('refuses a transfer leg', async () => {
    makeDb()
    const t = await insertTransfer({ from_account_id: 'hdfc', to_account_id: 'cash', amount: 500, entry_date: '2026-10-16' })
    const res = await reverseCashbookEntry(t.data!.outflow.id, { entry_date: '2026-10-16' })
    expect(res.error).toMatch(/transfer/)
  })
})

// ── Before migration 20261016100000 is applied ───────────────────────────────

describe('before the reversal migration', () => {
  /** The cascade as it was: invoice allocations only. */
  const oldTriggers: MemoryDbOptions['triggers'] = (event, d) => {
    if (event.table === 'cashbook_entries') {
      event.rows.forEach(e => {
        if (!e.deleted_at) return
        const hit = d.rows('cashbook_invoice_allocations').filter(a => a.cashbook_entry_id === e.id && !a.deleted_at)
        const before = hit.map(a => ({ ...a }))
        for (const a of hit) a.deleted_at = e.deleted_at
        if (hit.length) cashbookTriggers({ table: 'cashbook_invoice_allocations', op: 'update', rows: hit, before }, d)
      })
      return
    }
    cashbookTriggers(event, d)
  }
  const missing = {
    cashbook_entries: ['reversal_of'],
    cashbook_invoice_allocations: ['released_by_entry_id'],
    cashbook_payroll_allocations: ['released_by_entry_id'],
  }

  it('Return / Reverse says what is needed and writes nothing', async () => {
    paidSalary()
    db.opts.missingColumns = missing
    const res = await reverseCashbookEntry('sal', { entry_date: '2026-10-03' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/20261016100000/)
    expect(db.rows('cashbook_entries')).toHaveLength(1)
    expect(db.get('payroll', 'pay1')!.status).toBe('paid')
  })

  it('deleting a salary entry still releases its payslip allocation', async () => {
    paidSalary()
    db.opts.missingColumns = missing
    db.opts.triggers = oldTriggers
    const del = await softDeleteCashbookEntry('sal')
    expect(del.ok).toBe(true)
    expect(db.get('cashbook_payroll_allocations', 'pa1')!.deleted_at).toBeTruthy()
    expect(db.get('payroll', 'pay1')!.status).toBe('pending')
  })
})
