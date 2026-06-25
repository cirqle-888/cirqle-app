import { describe, it, expect } from 'vitest'
import { buildRequestDraft } from './adapters/request'
import { buildTaskDraft } from './adapters/task'
import { buildOfferDraft } from './adapters/offer'
import { buildClientDraft } from './adapters/client'
import { buildInvoiceDraft } from './adapters/invoice'
import { buildQuotationDraft } from './adapters/quotation'
import type { DetectedClient } from './types'

const acme: DetectedClient = { id: 'c1', name: 'Acme', matchedBy: 'phone' }

describe('adapter draft builders (pure)', () => {
  it('request: maps parsed fields + detected client', () => {
    const d = buildRequestDraft(
      'need a logo',
      { title: 'Logo design', service: 'Branding', dueDate: '2026-07-01' },
      acme, { id: 's1', name: 'Branding' },
    )
    expect(d.type).toBe('request')
    expect(d.target).toBe('/dashboard/requests')
    expect(d.fields).toMatchObject({
      title: 'Logo design', description: 'need a logo',
      clientId: 'c1', serviceId: 's1', dueDate: '2026-07-01',
    })
  })

  it('request: truncates a missing title to 80 chars, nulls unknown service/client', () => {
    const d = buildRequestDraft('x'.repeat(200), {}, null, null)
    expect((d.fields.title as string).length).toBe(80)
    expect(d.fields.serviceId).toBeNull()
    expect(d.client).toBeNull()
  })

  it('task: maps title and routes to tasks', () => {
    const d = buildTaskDraft('fix server', { title: 'Fix server', dueDate: 'today' }, null)
    expect(d.type).toBe('task')
    expect(d.target).toBe('/dashboard/tasks')
    expect(d.fields.title).toBe('Fix server')
  })

  it('offer: summarizes product count + client', () => {
    const d = buildOfferDraft([{ name: 'Rice', price: 350, mrp: null, weight: '5kg' }], acme)
    expect(d.type).toBe('offer')
    expect(d.summary).toContain('1 product')
    expect(d.summary).toContain('Acme')
    expect((d.fields.products as unknown[]).length).toBe(1)
  })

  it('client: prefills new contact, and flags an existing match', () => {
    const fresh = buildClientDraft({ name: 'New Co', phone: '9876543210', email: null }, null)
    expect(fresh.fields).toMatchObject({ name: 'New Co', phone: '9876543210', existingClientId: null })

    const existing = buildClientDraft({ name: 'x', phone: null, email: null }, acme)
    expect(existing.fields.existingClientId).toBe('c1')
    expect(existing.summary).toContain('Existing client')
  })

  it('invoice + quotation: carry client + raw text to their modules', () => {
    expect(buildInvoiceDraft('bill text', acme))
      .toMatchObject({ type: 'invoice', target: '/dashboard/invoices', fields: { clientId: 'c1', raw: 'bill text' } })
    expect(buildQuotationDraft('quote pls', acme))
      .toMatchObject({ type: 'quotation', target: '/dashboard/quotations', fields: { clientId: 'c1', notes: 'quote pls' } })
  })
})
