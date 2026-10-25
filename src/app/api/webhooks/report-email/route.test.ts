import { beforeEach, describe, expect, it, vi } from 'vitest'
const { verify, rpc } = vi.hoisted(() => ({ verify: vi.fn(), rpc: vi.fn() }))
vi.mock('@/lib/email/resend', () => ({ getResend: () => ({ webhooks: { verify } }) }))
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({ rpc }) }))
import { POST } from './route'
const request = () => new Request('http://localhost/api/webhooks/report-email', { method: 'POST', body: '{}', headers: { 'svix-id': 'event-1', 'svix-timestamp': '123', 'svix-signature': 'signature' } })
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('RESEND_REPORT_WEBHOOK_SECRET', 'secret'); rpc.mockResolvedValue({ error: null }) })
describe('report delivery webhook', () => {
  it('rejects invalid signatures without writing', async () => {
    verify.mockImplementation(() => { throw new Error('Invalid') })
    expect((await POST(request())).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('records signed delivery with provider event identity and time', async () => {
    verify.mockReturnValue({ type: 'email.delivered', created_at: '2026-10-25T00:00:00Z', data: { email_id: 'provider-1' } })
    expect((await POST(request())).status).toBe(200)
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ webhookSecret: 'secret', payload: '{}' }))
    expect(rpc).toHaveBeenCalledWith('record_report_delivery_event', { p_event_id: 'event-1', p_provider_id: 'provider-1', p_state: 'delivered', p_occurred_at: '2026-10-25T00:00:00Z' })
  })
  it('ignores unrelated provider events', async () => {
    verify.mockReturnValue({ type: 'email.opened', data: { email_id: 'provider-1' } })
    expect((await POST(request())).status).toBe(200)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('asks the provider to retry database failure', async () => {
    verify.mockReturnValue({ type: 'email.bounced', created_at: '2026-10-25T00:00:00Z', data: { email_id: 'provider-1' } })
    rpc.mockResolvedValue({ error: { message: 'unavailable' } })
    expect((await POST(request())).status).toBe(503)
  })
})
