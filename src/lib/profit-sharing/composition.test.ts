import { describe, it, expect } from 'vitest'
import { deriveComposition, splitAllocations } from './composition'
import type { Composition, InvoiceRaw } from './types'

const invoice = (over: Partial<InvoiceRaw> = {}): InvoiceRaw => ({
  id: 'inv', clientId: 'c1', status: 'sent', exchangeRate: 1,
  totalAmount: 23000, totalAmountInr: 23000, taxAmount: 0, discountAmount: 0, previousBalance: 0,
  updatedOn: null, itemsTotal: 3000, markupTotal: 0, adSpendInr: 20000, expenseOriginalInr: 0,
  ...over,
})

describe('deriveComposition (design §3.4)', () => {
  it('separates the agency fee from ad spend passed through', () => {
    const d = deriveComposition(invoice())
    expect(d.problem).toBeNull()
    expect(d.composition).toEqual({ ownInr: 3000, passInr: 20000, taxInr: 0, carriedInr: 0, totalInr: 23000 })
  })

  it('counts markup as own revenue and the rebilled original as pass-through', () => {
    const d = deriveComposition(invoice({ itemsTotal: 0, adSpendInr: 0, markupTotal: 500, expenseOriginalInr: 5000, totalAmount: 5500, totalAmountInr: 5500 }))
    expect(d.composition.ownInr).toBe(500)
    expect(d.composition.passInr).toBe(5000)
    expect(d.problem).toBeNull()
  })

  it('takes a discount off own revenue only', () => {
    const d = deriveComposition(invoice({ discountAmount: 1000, totalAmount: 22000, totalAmountInr: 22000 }))
    expect(d.composition.ownInr).toBe(2000)
    expect(d.composition.passInr).toBe(20000)
  })

  it('sends an invoice whose parts do not add up to review', () => {
    expect(deriveComposition(invoice({ totalAmountInr: 30000 })).problem).toBe('mismatch')
  })

  it('sends a carried balance to review', () => {
    expect(deriveComposition(invoice({ previousBalance: 1000, totalAmount: 24000, totalAmountInr: 24000 })).problem).toBe('carried_balance')
  })

  it('sends a tax-bearing invoice to review while D1 is open', () => {
    expect(deriveComposition(invoice({ taxAmount: 540, totalAmount: 23540, totalAmountInr: 23540 })).problem).toBe('tax_unconfirmed')
  })

  it('converts a foreign-currency invoice at its rate', () => {
    const d = deriveComposition(invoice({ exchangeRate: 80, itemsTotal: 100, adSpendInr: 0, totalAmount: 100, totalAmountInr: 8000 }))
    expect(d.composition.ownInr).toBe(8000)
    expect(d.problem).toBeNull()
  })
})

describe('splitAllocations — D2 order: pass-through, then tax, then own revenue', () => {
  const comp: Composition = { ownInr: 3000, passInr: 20000, taxInr: 0, carriedInr: 0, totalInr: 23000 }
  const dates = new Map([['e1', '2026-09-05'], ['e2', '2026-10-10']])

  it('recovers pass-through before recognising any of Cirqle’s fee (§4.3)', () => {
    const s = splitAllocations(
      [{ entryId: 'e1', invoiceId: 'inv', amountInr: 20000, allocatedOn: '2026-09-30' },
       { entryId: 'e2', invoiceId: 'inv', amountInr: 3000, allocatedOn: '2026-10-10' }],
      dates, new Map([['inv', comp]]))
    expect(s[0]).toMatchObject({ recognisedOn: '2026-09-30', passInr: 20000, ownInr: 0, excessInr: 0 })
    expect(s[1]).toMatchObject({ recognisedOn: '2026-10-10', passInr: 0, ownInr: 3000, excessInr: 0 })
  })

  it('applies tax after pass-through and before own revenue', () => {
    const s = splitAllocations(
      [{ entryId: 'e1', invoiceId: 'inv', amountInr: 21000, allocatedOn: '2026-09-05' }],
      dates, new Map([['inv', { ownInr: 3000, passInr: 20000, taxInr: 1500, carriedInr: 0, totalInr: 24500 }]]))
    expect(s[0]).toMatchObject({ passInr: 20000, taxInr: 1000, ownInr: 0 })
  })

  it('keeps anything beyond the invoice as excess, so no rupee is recognised twice', () => {
    const s = splitAllocations(
      [{ entryId: 'e1', invoiceId: 'inv', amountInr: 25000, allocatedOn: '2026-09-05' }],
      dates, new Map([['inv', comp]]))
    expect(s[0]).toMatchObject({ passInr: 20000, ownInr: 3000, excessInr: 2000 })
    expect(s[0].passInr + s[0].taxInr + s[0].ownInr + s[0].excessInr).toBe(25000)
  })
})
