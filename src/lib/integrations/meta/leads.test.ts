import { describe, it, expect, beforeAll, vi } from 'vitest'

// leads.ts imports the notifications/activity chain, which pulls in
// `server-only` (a Next-provided module) via push/send. normalizeLeadFields is
// pure and needs none of it — mock those modules so the import is hermetic.
vi.mock('@/lib/notifications/create', () => ({ createNotification: vi.fn(), notifyAdmins: vi.fn() }))
vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn() }))

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon'
})

async function fn() {
  return (await import('./leads')).normalizeLeadFields
}

describe('normalizeLeadFields', () => {
  it('extracts full_name, email and phone_number', async () => {
    const normalize = await fn()
    const r = normalize([
      { name: 'full_name', values: ['Asha Menon'] },
      { name: 'email', values: ['asha@example.com'] },
      { name: 'phone_number', values: ['+91 98765 43210'] },
    ])
    expect(r.fullName).toBe('Asha Menon')
    expect(r.email).toBe('asha@example.com')
    expect(r.phone).toBe('+91 98765 43210')
  })

  it('combines first_name + last_name when no full_name', async () => {
    const normalize = await fn()
    const r = normalize([
      { name: 'first_name', values: ['Asha'] },
      { name: 'last_name', values: ['Menon'] },
    ])
    expect(r.fullName).toBe('Asha Menon')
  })

  it('handles alternate keys (work_email, whatsapp_number)', async () => {
    const normalize = await fn()
    const r = normalize([
      { name: 'work_email', values: ['w@e.com'] },
      { name: 'whatsapp_number', values: ['123'] },
    ])
    expect(r.email).toBe('w@e.com')
    expect(r.phone).toBe('123')
  })

  it('joins multiple values with ", "', async () => {
    const normalize = await fn()
    const r = normalize([{ name: 'interests', values: ['a', 'b', 'c'] }])
    expect(r.raw.interests).toBe('a, b, c')
  })

  it('skips empty values and preserves unknown fields in raw', async () => {
    const normalize = await fn()
    const r = normalize([
      { name: 'city', values: ['Kochi'] },
      { name: 'blank', values: [''] },
      { name: 'nothing', values: [] },
    ])
    expect(r.raw.city).toBe('Kochi')
    expect(r.raw.blank).toBeUndefined()
    expect(r.raw.nothing).toBeUndefined()
  })

  it('matches keys case-insensitively', async () => {
    const normalize = await fn()
    const r = normalize([{ name: 'EMAIL', values: ['UP@e.com'] }])
    expect(r.email).toBe('UP@e.com')
  })

  it('returns all-null on an empty array', async () => {
    const normalize = await fn()
    const r = normalize([])
    expect(r.fullName).toBeNull()
    expect(r.email).toBeNull()
    expect(r.phone).toBeNull()
    expect(r.raw).toEqual({})
  })

  it('tolerates null/undefined', async () => {
    const normalize = await fn()
    expect(normalize(null).raw).toEqual({})
    expect(normalize(undefined).email).toBeNull()
  })
})
