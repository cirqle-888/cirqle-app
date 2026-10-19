import { describe, it, expect } from 'vitest'
import { renderQuotationHtml } from './render'
import { renderInvoiceHtml } from '@/lib/invoices/render-html'

/** Asserted on the rendered HTML: this is what the client receives. */
const quote = {
  quotation_number: 'QUO-2610-TST',
  issue_date: '2026-10-19',
  valid_until: '2026-11-18',
  currency: 'INR',
  total_amount: 8500,
  notes: 'Fabric sourced by client.',
  terms: 'Payment due within 7 days of approval.',
  client: { name: 'Test Client', phone: '9999999999' },
  items: [
    { description: 'Design', quantity: 1, unit_price: 1500, total: 1500, display_order: 1 },
    { description: 'Curtain printing', quantity: 2, unit_price: 3500, total: 7000, display_order: 0 },
  ],
}

const settings = { company_name: 'Cirqle Works', bank_upi: 'cirqle@upi', bank_holder: 'Cirqle Works' }

describe('the quotation document', () => {
  const html = renderQuotationHtml(quote, settings)

  it('is labelled as a quotation, not an invoice', () => {
    expect(html).toContain('>QUOTATION<')
    expect(html).toContain('Quotation No.')
    expect(html).toContain('QUO-2610-TST')
    expect(html).toContain('Valid Until')
    expect(html).toContain('18/11/2026')
    expect(html).toContain('Quote for :')
    expect(html).toContain('Quotation Total')
    expect(html).not.toContain('>INVOICE<')
    expect(html).not.toContain('Invoice No.')
    expect(html).not.toContain('Total Payable')
    expect(html).not.toContain('Bill to :')
  })

  it('carries the company branding the invoices use', () => {
    expect(html).toContain('Cirqle Works')
  })

  it('lists lines in entry order with the amounts, and prints the total once', () => {
    expect(html.indexOf('Curtain printing')).toBeLessThan(html.indexOf('Design'))
    expect(html).toContain('₹7,000.00')
    expect(html).toContain('₹8,500.00')
    expect(html).not.toContain('Total Amount Due')
    expect(html).not.toContain('>Date</th>') // quotation lines have no dates
  })

  it('prints the notes and the terms', () => {
    expect(html).toContain('Fabric sourced by client.')
    expect(html).toContain('Payment due within 7 days of approval.')
  })

  it('asks for no payment and thanks nobody for business not yet won', () => {
    expect(html).not.toContain('upi://pay')
    expect(html).not.toContain('Payment&nbsp;Information')
    expect(html).not.toContain('cirqle@upi')
    expect(html).not.toContain('Thank you')
    // The company strip still closes the page.
    expect(html).toContain('Cirqle Works</div>')
  })

  it('leaves invoices exactly as they were', () => {
    const inv = renderInvoiceHtml({
      invoice_number: 'INV-1', issue_date: '2026-10-01', due_date: '2026-10-15', currency: 'INR',
      total_amount: 100, subtotal: 100, terms: 'not printed on invoices',
      items: [{ description: 'Poster', quantity: 1, unit_price: 100, total: 100, line_date: '2026-10-01' }],
    }, settings)
    expect(inv).toContain('>INVOICE<')
    expect(inv).toContain('Due Date')
    expect(inv).toContain('Total Payable')
    expect(inv).toContain('Total Amount Due')
    expect(inv).toContain('>Date</th>')
    expect(inv).not.toContain('not printed on invoices')
    expect(inv).toContain('Payment&nbsp;Information')
    expect(inv).toContain('Thank you')
  })
})
