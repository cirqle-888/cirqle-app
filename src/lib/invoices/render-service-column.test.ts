import { describe, it, expect } from 'vitest'
import { renderInvoiceHtml } from './render-html'

/**
 * The Service column is a change to a CLIENT-FACING document, so it is asserted
 * against the real rendered HTML rather than the flag that drives it.
 */

const baseInvoice = (over: Record<string, unknown> = {}) => ({
  invoice_number: 'INV-TEST-001',
  issue_date: '2026-09-01',
  currency: 'INR',
  status: 'sent',
  subtotal: 800, total_amount: 800, paid_amount: 0,
  client: { id: 'c1', name: 'Test Client', ...(over.client as object ?? {}) },
  items: [
    { description: 'Independence Day Poster', quantity: 1, unit_price: 500, total: 500,
      service: { id: 's1', name: 'Offer Flyer' }, line_date: '2026-08-15' },
    { description: 'Onam Poster', quantity: 2, unit_price: 150, total: 300,
      service: { id: 's2', name: 'Social Media Poster' }, line_date: '2026-08-21' },
  ],
  ...over,
})

const render = (inv: Record<string, unknown>) => renderInvoiceHtml(inv, {})

describe('the Service column', () => {
  it('is absent by default — existing invoices keep their shape', () => {
    const html = render(baseInvoice())
    expect(html).not.toContain('>Service<')
    expect(html).not.toContain('Social Media Poster')
    // The work itself is still listed; only the category column is gone.
    expect(html).toContain('Independence Day Poster')
  })

  it('appears when the client is set up for it', () => {
    const html = render(baseInvoice({ client: { id: 'c1', name: 'Test Client', invoice_show_services: true } }))
    expect(html).toContain('>Service<')
    expect(html).toContain('Offer Flyer')
    expect(html).toContain('Social Media Poster')
  })

  it('appears when this one invoice asks for it, whatever the client says', () => {
    const html = render(baseInvoice({
      show_service_column: true,
      client: { id: 'c1', name: 'Test Client', invoice_show_services: false },
    }))
    expect(html).toContain('>Service<')
  })

  it('can be turned off for one invoice belonging to a client who normally gets it', () => {
    const html = render(baseInvoice({
      show_service_column: false,
      client: { id: 'c1', name: 'Test Client', invoice_show_services: true },
    }))
    expect(html).not.toContain('>Service<')
  })

  it('leaves the cell blank for a line with no service, rather than breaking the row', () => {
    const html = render(baseInvoice({
      client: { id: 'c1', name: 'Test Client', invoice_show_services: true },
      items: [{ description: 'Manual line', quantity: 1, unit_price: 100, total: 100 }],
    }))
    expect(html).toContain('>Service<')
    expect(html).toContain('Manual line')
  })

  it('spans the empty-state row across the right number of columns', () => {
    // A colspan that does not match the header leaves a ragged table on a
    // document that goes to a client.
    expect(render(baseInvoice({ items: [] }))).toContain('colspan="6"')
    expect(render(baseInvoice({
      items: [], client: { id: 'c1', name: 'Test Client', invoice_show_services: true },
    }))).toContain('colspan="7"')
  })

  it('keeps every other column when the service one is added', () => {
    const html = render(baseInvoice({ client: { id: 'c1', name: 'Test Client', invoice_show_services: true } }))
    for (const header of ['No.', 'Date', 'Jobs Done', 'Qty', 'Rate', 'Total Amount']) {
      expect(html, `${header} column went missing`).toContain(`>${header}<`)
    }
  })
})
