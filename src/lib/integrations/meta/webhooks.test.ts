import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createHmac } from 'crypto'

// webhooks.ts → leads.ts → notifications/create → push/send imports
// `server-only`. verifyMetaSignature is pure; mock the chain for a hermetic import.
vi.mock('@/lib/notifications/create', () => ({ createNotification: vi.fn(), notifyAdmins: vi.fn() }))
vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn() }))

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon'
  process.env.META_APP_SECRET = 'app-secret-xyz'
})

async function verify() {
  return (await import('./webhooks')).verifyMetaSignature
}

function sign(body: string, secret = 'app-secret-xyz') {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

describe('verifyMetaSignature', () => {
  const body = JSON.stringify({ object: 'page', entry: [{ id: '1', changes: [] }] })

  it('accepts a correctly signed body', async () => {
    const v = await verify()
    expect(v(body, sign(body))).toBe(true)
  })

  it('rejects a signature made with the wrong secret', async () => {
    const v = await verify()
    expect(v(body, sign(body, 'wrong-secret'))).toBe(false)
  })

  it('rejects a missing header', async () => {
    const v = await verify()
    expect(v(body, null)).toBe(false)
  })

  it('rejects a non-sha256 algorithm', async () => {
    const v = await verify()
    const md5ish = 'md5=' + createHmac('sha256', 'app-secret-xyz').update(body).digest('hex')
    expect(v(body, md5ish)).toBe(false)
  })

  it('rejects a header with no "="', async () => {
    const v = await verify()
    expect(v(body, 'sha256')).toBe(false)
  })

  it('rejects when the body changed', async () => {
    const v = await verify()
    const sig = sign(body)
    expect(v(body + ' ', sig)).toBe(false)
  })

  it('rejects odd-length / malformed hex without throwing', async () => {
    const v = await verify()
    expect(v(body, 'sha256=zzz')).toBe(false)
  })
})
