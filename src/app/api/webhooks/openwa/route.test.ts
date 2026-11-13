import { createHmac } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const mocks = vi.hoisted(() => ({ after: vi.fn(), createAdminClient: vi.fn() }))
vi.mock('next/server', async importOriginal => ({ ...(await importOriginal<typeof import('next/server')>()), after: mocks.after }))
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: mocks.createAdminClient, fetchAll: vi.fn(), fetchAllIn: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.createAdminClient }))
vi.mock('@/lib/push/send', () => ({ sendWebPush: vi.fn() }))

import { NextRequest } from 'next/server'
import { POST } from './route'

const SECRET = 'test-secret-0123456789'
const message = {
  event: 'message.received', sessionId: 'desk', timestamp: '2026-11-10T09:00:00Z',
  data: { id: 'M1', chatId: '1203630212@g.us', from: '1203630212@g.us', body: 'Need a flyer', type: 'text', isGroup: true, fromMe: false },
}

function call(body: string, signature?: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (signature) headers['x-openwa-signature'] = signature
  return POST(new NextRequest('http://localhost/api/webhooks/openwa', { method: 'POST', body, headers }))
}
const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

/**
 * The listener runs as the service role, so the signature is the only gate.
 * A request that fails it must never reach the database or schedule any work.
 */
describe('WhatsApp listener webhook', () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.OPENWA_WEBHOOK_SECRET = SECRET })
  afterEach(() => { delete process.env.OPENWA_WEBHOOK_SECRET })

  it('refuses everything when no secret is configured', async () => {
    delete process.env.OPENWA_WEBHOOK_SECRET
    const body = JSON.stringify(message)
    expect((await call(body, sign(body))).status).toBe(503)
    process.env.OPENWA_WEBHOOK_SECRET = 'short'
    expect((await call(body, sign(body, 'short'))).status).toBe(503)
    expect(mocks.after).not.toHaveBeenCalled()
  })

  it('refuses a missing, wrong or stale signature before touching anything', async () => {
    const body = JSON.stringify(message)
    expect((await call(body)).status).toBe(401)
    expect((await call(body, sign(body, 'some-other-secret-000'))).status).toBe(401)
    expect((await call(body, sign(JSON.stringify({ ...message, sessionId: 'x' })))).status).toBe(401)
    expect(mocks.after).not.toHaveBeenCalled()
    expect(mocks.createAdminClient).not.toHaveBeenCalled()
  })

  it('acknowledges non-message events at once and only notes afterwards that the gateway is alive', async () => {
    const body = JSON.stringify({ event: 'session.status', sessionId: 'desk', data: { status: 'connected' } })
    const res = await call(body, sign(body))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, result: 'ignored' })
    expect(mocks.after).toHaveBeenCalledTimes(1)
    expect(mocks.createAdminClient).not.toHaveBeenCalled() // only inside the deferred work
  })

  it('accepts a signed message at once and does the work after replying', async () => {
    const body = JSON.stringify(message)
    const res = await call(body, sign(body))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, result: 'accepted' })
    expect(mocks.after).toHaveBeenCalledTimes(1)
    expect(mocks.createAdminClient).not.toHaveBeenCalled() // only inside the deferred work
  })

  it('rejects signed junk', async () => {
    const body = 'not json'
    expect((await call(body, sign(body))).status).toBe(400)
  })

  it('is exempt from the session middleware and contains no code that sends to WhatsApp', () => {
    const mw = readFileSync(join(process.cwd(), 'src/lib/supabase/middleware.ts'), 'utf8')
    expect(mw).toContain("pathname.startsWith('/api/webhooks/')")
    for (const f of ['src/app/api/webhooks/openwa/route.ts', 'src/lib/whatsapp-listener/handle.ts', 'src/lib/whatsapp-listener/rules.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      expect(src, f).not.toMatch(/fetch\(/)
      expect(src, f).not.toMatch(/send-text|sendMessage|\/messages\/send/)
    }
  })
})
