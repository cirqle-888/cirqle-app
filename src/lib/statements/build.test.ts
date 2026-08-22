import { describe, it, expect } from 'vitest'
import { buildStatement, dedupeCredits, nativeRate } from './build'
import type { StatementInvoice, StatementCredit } from './build'

const inv = (o: Partial<StatementInvoice> & { id: string }): StatementInvoice => ({
  invoice_number: o.id.toUpperCase(), issue_date: '2026-06-10', due_date: null, status: 'sent',
  currency: 'INR', total_amount: 1000, paid_amount: 0,
  total_amount_inr: 1000, paid_amount_inr: 0, exchange_rate: 1, ...o,
})
const cr = (o: Partial<StatementCredit> & { invoiceId: string }): StatementCredit => ({
  date: '2026-06-20', amountInr: 500, source: 'allocation', ...o,
})

describe('dedupeCredits', () => {
  it('drops the payments row that mirrors an allocation of the same money', () => {
    // recordInvoicePayment writes a payment AND auto-creates a cashbook entry
    // which is then allocated — same money, two tables.
    const out = dedupeCredits([
      cr({ invoiceId: 'a', date: '2026-06-20', amountInr: 250, source: 'payment' }),
      cr({ invoiceId: 'a', date: '2026-06-20', amountInr: 250, source: 'allocation' }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('allocation')
  })

  it('keeps two genuine part-payments made on the same day for different amounts', () => {
    const out = dedupeCredits([
      cr({ invoiceId: 'a', date: '2026-06-20', amountInr: 250 }),
      cr({ invoiceId: 'a', date: '2026-06-20', amountInr: 400 }),
    ])
    expect(out).toHaveLength(2)
  })

  it('keeps same-amount credits on different invoices', () => {
    expect(dedupeCredits([
      cr({ invoiceId: 'a', amountInr: 250 }),
      cr({ invoiceId: 'b', amountInr: 250 }),
    ])).toHaveLength(2)
  })
})

describe('buildStatement — opening balance', () => {
  it('carries prior billing and prior receipts into the opening balance', () => {
    const s = buildStatement({
      invoices: [
        inv({ id: 'old', issue_date: '2026-05-01', total_amount: 1000, paid_amount: 400, paid_amount_inr: 400 }),
        inv({ id: 'new', issue_date: '2026-06-15', total_amount: 700 }),
      ],
      credits: [cr({ invoiceId: 'old', date: '2026-05-20', amountInr: 400 })],
      from: '2026-06-01', to: '2026-06-30', currency: 'INR',
    })
    expect(s.openingBalance).toBe(600)          // 1000 billed − 400 received
    expect(s.rows).toHaveLength(1)               // only the June invoice is in-period
    expect(s.closingBalance).toBe(1300)          // 600 + 700
  })

  it('starts at zero when nothing precedes the window', () => {
    const s = buildStatement({
      invoices: [inv({ id: 'a', issue_date: '2026-06-15' })],
      credits: [], from: '2026-06-01', to: '2026-06-30', currency: 'INR',
    })
    expect(s.openingBalance).toBe(0)
  })
})

describe('buildStatement — running balance', () => {
  it('orders oldest-first and raises an invoice before crediting it on the same day', () => {
    const s = buildStatement({
      invoices: [inv({ id: 'a', issue_date: '2026-06-10', total_amount: 1000, paid_amount: 1000, paid_amount_inr: 1000 })],
      credits: [cr({ invoiceId: 'a', date: '2026-06-10', amountInr: 1000 })],
      from: '2026-06-01', to: '2026-06-30', currency: 'INR',
    })
    expect(s.rows.map(r => r.kind)).toEqual(['invoice', 'credit'])
    expect(s.rows.map(r => r.balance)).toEqual([1000, 0])
    expect(s.totalBilled).toBe(1000)
    expect(s.totalReceived).toBe(1000)
    expect(s.closingBalance).toBe(0)
  })
})

describe('buildStatement — foreign currency', () => {
  it('converts INR credits back to the invoice currency via its own rate', () => {
    // A QAR invoice: 100 QAR billed = 2500 INR, so the rate is 25.
    const s = buildStatement({
      invoices: [inv({
        id: 'q', currency: 'QAR', issue_date: '2026-06-10',
        total_amount: 100, total_amount_inr: 2500,
        paid_amount: 40, paid_amount_inr: 1000, exchange_rate: 25,
      })],
      credits: [cr({ invoiceId: 'q', date: '2026-06-20', amountInr: 1000 })],
      from: '2026-06-01', to: '2026-06-30', currency: 'QAR',
    })
    expect(nativeRate({ ...inv({ id: 'q' }), total_amount: 100, total_amount_inr: 2500 })).toBe(25)
    expect(s.rows[1].credit).toBe(40)   // 1000 INR ÷ 25
    expect(s.closingBalance).toBe(60)   // 100 − 40, in QAR
  })
})

describe('buildStatement — aging', () => {
  const asOf = '2026-06-30'
  it('buckets an unpaid invoice by days past its due date', () => {
    const s = buildStatement({
      invoices: [
        inv({ id: 'a', issue_date: '2026-01-01', due_date: '2026-01-01', total_amount: 100 }), // 180d
        inv({ id: 'b', issue_date: '2026-05-15', due_date: '2026-05-15', total_amount: 200 }), // 46d
        inv({ id: 'c', issue_date: '2026-06-20', due_date: '2026-06-20', total_amount: 300 }), // 10d
        inv({ id: 'd', issue_date: '2026-06-25', due_date: '2026-07-30', total_amount: 400 }), // not due
      ],
      credits: [], from: '2026-06-01', to: asOf, currency: 'INR',
    })
    const by = Object.fromEntries(s.aging.map(b => [b.label, b.amount]))
    expect(by['90+ days']).toBe(100)
    expect(by['31–60 days']).toBe(200)
    expect(by['0–30 days']).toBe(300)
    expect(by['Not yet due']).toBe(400)
    expect(s.totalOutstanding).toBe(1000)
  })

  it('ages a part-paid invoice by what is still owed, and ignores settled ones', () => {
    const s = buildStatement({
      invoices: [
        inv({ id: 'a', issue_date: '2026-06-01', due_date: '2026-06-01', total_amount: 1000, total_amount_inr: 1000, paid_amount: 600, paid_amount_inr: 600 }),
        inv({ id: 'b', issue_date: '2026-06-01', due_date: '2026-06-01', total_amount: 500, total_amount_inr: 500, paid_amount: 500, paid_amount_inr: 500 }),
      ],
      credits: [
        cr({ invoiceId: 'a', date: '2026-06-10', amountInr: 600 }),
        cr({ invoiceId: 'b', date: '2026-06-10', amountInr: 500 }),
      ],
      from: '2026-06-01', to: asOf, currency: 'INR',
    })
    expect(s.totalOutstanding).toBe(400)
    expect(s.discrepancies).toEqual([])
  })

  it('ignores credits dated after the statement date when ageing', () => {
    const s = buildStatement({
      invoices: [inv({ id: 'a', issue_date: '2026-06-01', due_date: '2026-06-01', total_amount: 1000, total_amount_inr: 1000 })],
      credits: [cr({ invoiceId: 'a', date: '2026-07-15', amountInr: 1000 })],
      from: '2026-06-01', to: asOf, currency: 'INR',
    })
    expect(s.totalOutstanding).toBe(1000)
  })

  it('excludes cancelled and written-off invoices from what is owed', () => {
    const s = buildStatement({
      invoices: [
        inv({ id: 'a', status: 'cancelled', total_amount: 900 }),
        inv({ id: 'b', status: 'bad_debt',  total_amount: 800 }),
        inv({ id: 'c', status: 'sent',      total_amount: 100 }),
      ],
      credits: [], from: '2026-06-01', to: asOf, currency: 'INR',
    })
    expect(s.totalOutstanding).toBe(100)
  })

  it('does not age an invoice issued after the statement date', () => {
    const s = buildStatement({
      invoices: [inv({ id: 'a', issue_date: '2026-07-10', due_date: '2026-07-10', total_amount: 100 })],
      credits: [], from: '2026-06-01', to: asOf, currency: 'INR',
    })
    expect(s.totalOutstanding).toBe(0)
  })
})

describe('buildStatement — credits that mirror each other do not double-count', () => {
  it('a direct payment recorded in both tables is counted once', () => {
    const s = buildStatement({
      invoices: [inv({ id: 'a', total_amount: 250, total_amount_inr: 250, paid_amount: 250, paid_amount_inr: 250 })],
      credits: [
        cr({ invoiceId: 'a', date: '2026-06-20', amountInr: 250, source: 'payment' }),
        cr({ invoiceId: 'a', date: '2026-06-20', amountInr: 250, source: 'allocation' }),
      ],
      from: '2026-06-01', to: '2026-06-30', currency: 'INR',
    })
    expect(s.totalReceived).toBe(250)
    expect(s.closingBalance).toBe(0)
  })
})

describe('buildStatement — books discrepancies', () => {
  it('reports an invoice whose stored paid_amount contradicts its dated credits', () => {
    // The real shape of INV-2606-058: a 44 AED invoice settled by a 1,144.76
    // INR allocation, but with paid_amount holding the INR figure (1200).
    const s = buildStatement({
      invoices: [inv({
        id: 'x', invoice_number: 'INV-2606-058', currency: 'AED',
        issue_date: '2026-06-01', due_date: '2026-06-01',
        total_amount: 44, total_amount_inr: 1144.76,
        paid_amount: 1200, paid_amount_inr: 1200, exchange_rate: 26.017275,
      })],
      credits: [cr({ invoiceId: 'x', date: '2026-06-10', amountInr: 1144.76 })],
      from: '2026-06-01', to: '2026-06-30', currency: 'AED',
    })
    expect(s.discrepancies).toHaveLength(1)
    expect(s.discrepancies[0].invoiceNumber).toBe('INV-2606-058')
    expect(s.discrepancies[0].storedPaid).toBe(1200)
    expect(s.discrepancies[0].ledgerPaid).toBe(44)
    // The ledger reports the truth: settled, not overpaid by 1,156.
    expect(s.totalOutstanding).toBe(0)
    expect(s.closingBalance).toBe(0)
  })

  it('stays silent when the books agree', () => {
    const s = buildStatement({
      invoices: [inv({ id: 'a', total_amount: 500, total_amount_inr: 500, paid_amount: 500, paid_amount_inr: 500 })],
      credits: [cr({ invoiceId: 'a', date: '2026-06-20', amountInr: 500 })],
      from: '2026-06-01', to: '2026-06-30', currency: 'INR',
    })
    expect(s.discrepancies).toEqual([])
  })
})

describe('buildStatement — ageing is measured as of today, not the period end', () => {
  const FUTURE_TO = '9999-12-31'   // what "All time" passes

  it('does not age a future-dated invoice against the year 9999', () => {
    const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
    const s = buildStatement({
      invoices: [inv({ id: 'a', issue_date: future, due_date: null, total_amount: 1000, total_amount_inr: 1000 })],
      credits: [], from: '0000-01-01', to: FUTURE_TO, currency: 'INR',
    })
    // Issued in the future — it is not outstanding yet at all.
    expect(s.totalOutstanding).toBe(0)
  })

  it('still ages a genuinely old unpaid invoice under All time', () => {
    const s = buildStatement({
      invoices: [inv({ id: 'a', issue_date: '2020-01-01', due_date: '2020-01-01', total_amount: 500, total_amount_inr: 500 })],
      credits: [], from: '0000-01-01', to: FUTURE_TO, currency: 'INR',
    })
    expect(Object.fromEntries(s.aging.map(b => [b.label, b.amount]))['90+ days']).toBe(500)
  })

  it('honours an explicit asOf', () => {
    const s = buildStatement({
      invoices: [inv({ id: 'a', issue_date: '2026-06-01', due_date: '2026-06-01', total_amount: 100, total_amount_inr: 100 })],
      credits: [], from: '2026-01-01', to: '2026-12-31', currency: 'INR', asOf: '2026-06-15',
    })
    expect(Object.fromEntries(s.aging.map(b => [b.label, b.amount]))['0–30 days']).toBe(100)
  })
})
