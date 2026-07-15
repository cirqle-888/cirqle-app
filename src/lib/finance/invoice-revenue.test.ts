import { describe, it, expect } from 'vitest'
import {
  recognisedRevenue, badDebtLoss, discountGiven, collectedAmount,
  billedForCollection, isRevenueInvoice,
} from './invoice-revenue'

const inv = (o: Partial<Parameters<typeof recognisedRevenue>[0]> & { status: string }) => ({
  total_amount: 0, paid_amount: 0, ...o,
})

describe('recognisedRevenue', () => {
  it('books the full billed amount on a normal invoice', () => {
    expect(recognisedRevenue(inv({ status: 'sent', total_amount: 1000, paid_amount: 0 }))).toBe(1000)
    expect(recognisedRevenue(inv({ status: 'paid', total_amount: 1000, paid_amount: 1000 }))).toBe(1000)
  })

  it('books only what was collected on a write-off — the rest is never revenue', () => {
    // VKM Hypermarket's real shape: billed 2000, recovered 1850, 150 lost.
    expect(recognisedRevenue(inv({ status: 'bad_debt', total_amount: 2000, paid_amount: 1850 }))).toBe(1850)
    expect(recognisedRevenue(inv({ status: 'bad_debt', total_amount: 1500, paid_amount: 0 }))).toBe(0)
  })

  it('books nothing for cancelled or unsent invoices', () => {
    expect(recognisedRevenue(inv({ status: 'cancelled', total_amount: 999 }))).toBe(0)
    expect(recognisedRevenue(inv({ status: 'draft', total_amount: 999 }))).toBe(0)
    expect(recognisedRevenue(inv({ status: 'reviewed', total_amount: 999 }))).toBe(0)
  })

  it('prefers the INR snapshot columns over the source-currency ones', () => {
    expect(recognisedRevenue(inv({
      status: 'sent', total_amount: 100, total_amount_inr: 8500,
    }))).toBe(8500)
  })
})

describe('badDebtLoss', () => {
  it('is the unrecovered remainder of a write-off', () => {
    expect(badDebtLoss(inv({ status: 'bad_debt', total_amount: 2000, paid_amount: 1850 }))).toBe(150)
  })

  it('is zero for every other status — including an unpaid live invoice', () => {
    expect(badDebtLoss(inv({ status: 'overdue', total_amount: 5000, paid_amount: 0 }))).toBe(0)
    expect(badDebtLoss(inv({ status: 'cancelled', total_amount: 5000 }))).toBe(0)
  })

  it('never goes negative if more was collected than billed', () => {
    expect(badDebtLoss(inv({ status: 'bad_debt', total_amount: 100, paid_amount: 130 }))).toBe(0)
  })
})

describe('recognisedRevenue + badDebtLoss reconcile to the billed amount', () => {
  it('splits a write-off into exactly revenue + loss', () => {
    const i = inv({ status: 'bad_debt', total_amount: 16281, paid_amount: 2850 })
    expect(recognisedRevenue(i) + badDebtLoss(i)).toBe(16281)
  })
})

describe('discountGiven', () => {
  it('uses the logged total when it exceeds the invoice column', () => {
    // INV-2408-015: the column holds only the LAST discount (200), logs sum to 300.
    expect(discountGiven(inv({ status: 'paid', discount_amount: 200 }), 300)).toBe(300)
  })

  it('falls back to the invoice column when there are no logs', () => {
    expect(discountGiven(inv({ status: 'paid', discount_amount: 250 }))).toBe(250)
  })

  it('counts nothing given away on a cancelled invoice — there was no sale', () => {
    expect(discountGiven(inv({ status: 'cancelled', discount_amount: 250 }), 250)).toBe(0)
  })
})

describe('collection rate inputs', () => {
  it('keeps write-offs in the denominator so the rate cannot exceed 100%', () => {
    const written = inv({ status: 'bad_debt', total_amount: 1000, paid_amount: 300 })
    expect(billedForCollection(written)).toBe(1000)   // the failure still counts as billed
    expect(collectedAmount(written)).toBe(300)        // and its recovery counts as collected
  })

  it('excludes drafts and cancellations from both sides', () => {
    expect(billedForCollection(inv({ status: 'draft', total_amount: 500 }))).toBe(0)
    expect(billedForCollection(inv({ status: 'cancelled', total_amount: 500 }))).toBe(0)
    expect(collectedAmount(inv({ status: 'cancelled', total_amount: 500, paid_amount: 500 }))).toBe(0)
  })
})

describe('isRevenueInvoice', () => {
  it('admits live and written-off invoices, rejects unsent and cancelled', () => {
    expect(isRevenueInvoice(inv({ status: 'sent' }))).toBe(true)
    expect(isRevenueInvoice(inv({ status: 'bad_debt' }))).toBe(true)
    expect(isRevenueInvoice(inv({ status: 'draft' }))).toBe(false)
    expect(isRevenueInvoice(inv({ status: 'cancelled' }))).toBe(false)
  })
})
