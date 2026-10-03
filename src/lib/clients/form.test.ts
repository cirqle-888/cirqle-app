import { describe, it, expect } from 'vitest'
import { sanitizeClientForm } from './form'

describe('sanitizeClientForm', () => {
  // The row the Clients list loads, as the edit form receives it.
  const listRow = {
    id: 'c1', name: 'Mazra Supermarket', code: '065', contact_name: null, email: null,
    phone: '7736264993', country: 'India', default_currency: 'INR', address: 'Valamkulam',
    gstin: null, is_active: true, pricing_pending: false, business_partner_id: null,
    created_at: '2026-10-01T00:00:00Z',
    is_draft: false, draft_note: null, draft_created_at: null,
    draft_creator: { name: 'Farooq' },
    service_pricings: [{ service_id: 's1', price: 200 }],
  }

  it('drops embedded relations — they are not columns and PostgREST rejects them', () => {
    const out = sanitizeClientForm(listRow)
    expect(out).not.toHaveProperty('draft_creator')
    expect(out).not.toHaveProperty('service_pricings')
  })

  it('keeps every field the form edits', () => {
    const out = sanitizeClientForm(listRow)
    for (const k of ['name', 'code', 'contact_name', 'email', 'phone', 'country', 'default_currency', 'address', 'gstin', 'is_active']) {
      expect(out).toHaveProperty(k)
    }
    expect(out.name).toBe('Mazra Supermarket')
    expect(out.phone).toBe('7736264993')
  })

  it('never writes identity, timestamps or draft state back from a stale form', () => {
    const out = sanitizeClientForm({ ...listRow, updated_at: 'old', draft_created_by: 'e1', is_draft: true })
    for (const k of ['id', 'created_at', 'updated_at', 'is_draft', 'draft_note', 'draft_created_at', 'draft_created_by']) {
      expect(out).not.toHaveProperty(k)
    }
  })

  it('keeps real JSON columns — stripping is by name, not by value shape', () => {
    const out = sanitizeClientForm({ ...listRow, integrations: { meta: { page: '1' } } })
    expect(out.integrations).toEqual({ meta: { page: '1' } })
  })

  it('does not mutate its input', () => {
    const input = { ...listRow }
    sanitizeClientForm(input)
    expect(input).toHaveProperty('draft_creator')
  })
})
