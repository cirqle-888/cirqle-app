import { describe, it, expect } from 'vitest'
import {
  belongsToBase,
  canDeleteQuotation,
  isQuotationEditable,
  needsRenumber,
  nextQuotationNumber,
  normaliseQuotationLines,
  quotationLink,
  quotationLockReason,
  quotationNumberBase,
  quotationToForm,
  quotationTotal,
} from './editing'

describe('which quotations can change', () => {
  it('drafts and sent quotations are editable; answered ones are not', () => {
    expect(isQuotationEditable('draft')).toBe(true)
    expect(isQuotationEditable('sent')).toBe(true)
    for (const s of ['approved', 'rejected', 'converted', '', null, undefined]) {
      expect(isQuotationEditable(s)).toBe(false)
    }
  })

  it('only a draft can be deleted', () => {
    expect(canDeleteQuotation('draft')).toBe(true)
    for (const s of ['sent', 'approved', 'rejected', 'converted']) expect(canDeleteQuotation(s)).toBe(false)
  })

  it('says why a locked quotation is read-only, and nothing for an editable one', () => {
    expect(quotationLockReason('draft')).toBeNull()
    expect(quotationLockReason('sent')).toBeNull()
    expect(quotationLockReason('approved')).toMatch(/approved/i)
    expect(quotationLockReason('rejected')).toMatch(/rejected/i)
    expect(quotationLockReason('converted')).toMatch(/invoice/i)
  })
})

describe('line items', () => {
  it('drops blank lines, trims, recomputes totals and keeps entry order', () => {
    const lines = normaliseQuotationLines([
      { description: '  Curtain printing ', quantity: 2, unit_price: 3500, total: 999 },
      { description: '   ', quantity: 1, unit_price: 100, total: 100 },
      { description: 'Design', quantity: 1, unit_price: 1500, total: 1500 },
    ])
    expect(lines).toEqual([
      { description: 'Curtain printing', quantity: 2, unit_price: 3500, total: 7000, display_order: 0 },
      { description: 'Design', quantity: 1, unit_price: 1500, total: 1500, display_order: 1 },
    ])
    expect(quotationTotal(lines)).toBe(8500)
  })

  it('never saves a zero or negative quantity, or a negative rate', () => {
    const [l] = normaliseQuotationLines([{ description: 'x', quantity: 0, unit_price: -5, total: 0 }])
    expect(l.quantity).toBe(1)
    expect(l.unit_price).toBe(0)
    expect(l.total).toBe(0)
  })

  it('rounds totals to paise', () => {
    const [l] = normaliseQuotationLines([{ description: 'x', quantity: 3, unit_price: 0.1, total: 0 }])
    expect(l.total).toBe(0.3)
  })
})

describe('prefilling the form from a saved quotation', () => {
  it('carries every editable field and orders lines by display_order', () => {
    const form = quotationToForm({
      client_id: 'c1', currency: 'INR', issue_date: '2026-10-19', valid_until: '2026-11-18',
      notes: 'Rush job', terms: 'Payment due within 7 days of approval.',
      items: [
        { description: 'Design', quantity: 1, unit_price: 1500, total: 1500, display_order: 1 },
        { description: 'Curtain printing', quantity: 2, unit_price: 3500, total: 7000, display_order: 0 },
      ],
    })
    expect(form).toEqual({
      client_id: 'c1', currency: 'INR', issue_date: '2026-10-19', valid_until: '2026-11-18',
      notes: 'Rush job', terms: 'Payment due within 7 days of approval.',
      items: [
        { description: 'Curtain printing', quantity: 2, unit_price: 3500, total: 7000 },
        { description: 'Design', quantity: 1, unit_price: 1500, total: 1500 },
      ],
    })
  })

  it('reads numeric strings (Postgres DECIMAL) and empty optionals', () => {
    const form = quotationToForm({
      client_id: null, currency: 'AED', issue_date: '2026-10-01', valid_until: null, notes: null, terms: null,
      items: [{ description: 'x', quantity: '2' as unknown as number, unit_price: '10.50' as unknown as number, total: '21.00' as unknown as number }],
    })
    expect(form.client_id).toBe('')
    expect(form.valid_until).toBe('')
    expect(form.notes).toBe('')
    expect(form.items[0]).toEqual({ description: 'x', quantity: 2, unit_price: 10.5, total: 21 })
  })

  it('gives a quotation with no lines one empty line to type into', () => {
    expect(quotationToForm({ client_id: 'c', currency: 'INR', issue_date: '2026-10-01', items: [] }).items)
      .toEqual([{ description: '', quantity: 1, unit_price: 0, total: 0 }])
  })
})

describe('quotation numbers', () => {
  it('builds QUO-<yymm>-<code> from the ISO date, without a timezone shift', () => {
    expect(quotationNumberBase('2026-10-19', '063')).toBe('QUO-2610-063')
    // The first of the month must not slide back into September anywhere.
    expect(quotationNumberBase('2026-10-01', 'abc')).toBe('QUO-2610-ABC')
    expect(quotationNumberBase('2026-10-01', '')).toBe('QUO-2610-001')
  })

  it('keeps the plain number for the first quotation of the month', () => {
    expect(nextQuotationNumber('QUO-2610-063', [])).toBe('QUO-2610-063')
  })

  it('suffixes the second and later ones instead of colliding', () => {
    expect(nextQuotationNumber('QUO-2610-063', ['QUO-2610-063'])).toBe('QUO-2610-063-2')
    expect(nextQuotationNumber('QUO-2610-063', ['QUO-2610-063', 'QUO-2610-063-2'])).toBe('QUO-2610-063-3')
    // A gap left by a deleted draft is not reused: the next is always past the highest.
    expect(nextQuotationNumber('QUO-2610-063', ['QUO-2610-063', 'QUO-2610-063-4'])).toBe('QUO-2610-063-5')
  })

  it('ignores another client whose code starts with this one', () => {
    // LIKE 'QUO-2610-06%' also returns client 063's quotations.
    expect(nextQuotationNumber('QUO-2610-06', ['QUO-2610-063', 'QUO-2610-063-2'])).toBe('QUO-2610-06')
    expect(belongsToBase('QUO-2610-063', 'QUO-2610-06')).toBe(false)
    expect(belongsToBase('QUO-2610-06-2', 'QUO-2610-06')).toBe(true)
  })

  it('renumbers a draft moved to another client or month, never a sent one', () => {
    expect(needsRenumber('draft', 'QUO-2610-063', 'QUO-2610-063')).toBe(false)
    expect(needsRenumber('draft', 'QUO-2610-063-2', 'QUO-2610-063')).toBe(false)
    expect(needsRenumber('draft', 'QUO-2610-063', 'QUO-2610-ABC')).toBe(true)
    expect(needsRenumber('draft', 'QUO-2610-063', 'QUO-2611-063')).toBe(true)
    expect(needsRenumber('sent', 'QUO-2610-063', 'QUO-2610-ABC')).toBe(false)
  })
})

describe('links', () => {
  it('opens the quotation on the Quotations page', () => {
    expect(quotationLink('https://app.cirqle.work/', 'q-1')).toBe('https://app.cirqle.work/dashboard/quotations?id=q-1')
  })
})
