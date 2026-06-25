import { describe, it, expect } from 'vitest'
import { extractContacts, detectClient, type ClientLookups } from './client-detect'
import type { CaptureInput } from './types'

const mk = (payload: string, metadata?: CaptureInput['metadata']): CaptureInput =>
  ({ source: 'manual_paste', kind: 'text', payload, metadata })

describe('extractContacts', () => {
  it('prefers metadata over text', () => {
    const c = extractContacts('call me at 9876543210 or a@b.com', {
      phone: '+91 99999 11111', email: 'meta@x.com', senderName: 'Sam',
    })
    expect(c).toEqual({ phone: '+91 99999 11111', email: 'meta@x.com', name: 'Sam' })
  })

  it('extracts a phone with >=10 digits from text', () => {
    expect(extractContacts('ping 98765 43210 thanks').phone).toBe('98765 43210')
  })

  it('ignores short digit runs', () => {
    expect(extractContacts('order 12345 ready').phone).toBeNull()
  })

  it('extracts and lowercases an email', () => {
    expect(extractContacts('mail Foo@Bar.COM now').email).toBe('foo@bar.com')
  })

  it('returns all-null when nothing is present', () => {
    expect(extractContacts('hello world')).toEqual({ phone: null, email: null, name: null })
  })
})

describe('detectClient', () => {
  const admin = {} as any
  const lookups = (
    hits: Partial<Record<'phone' | 'email' | 'name', { id: string; name: string }>>,
  ): ClientLookups => ({
    byPhone: async () => hits.phone ?? null,
    byEmail: async () => hits.email ?? null,
    byName:  async () => hits.name ?? null,
  })

  it('matches by phone first (over email)', async () => {
    const r = await detectClient(
      admin, mk('hi', { phone: '9876543210' }), undefined,
      lookups({ phone: { id: 'c1', name: 'Acme' }, email: { id: 'c2', name: 'Other' } }),
    )
    expect(r).toEqual({ id: 'c1', name: 'Acme', matchedBy: 'phone' })
  })

  it('falls back to email', async () => {
    const r = await detectClient(admin, mk('a@b.com'), undefined, lookups({ email: { id: 'c2', name: 'Beta' } }))
    expect(r).toEqual({ id: 'c2', name: 'Beta', matchedBy: 'email' })
  })

  it('falls back to a name from the classifier hint', async () => {
    const r = await detectClient(
      admin, mk('no contacts here'),
      { type: 'request', confidence: 0.9, hints: { client: 'Gamma' } },
      lookups({ name: { id: 'c3', name: 'Gamma' } }),
    )
    expect(r).toEqual({ id: 'c3', name: 'Gamma', matchedBy: 'name' })
  })

  it('returns null when nothing matches', async () => {
    expect(await detectClient(admin, mk('a@b.com'), undefined, lookups({}))).toBeNull()
  })
})
