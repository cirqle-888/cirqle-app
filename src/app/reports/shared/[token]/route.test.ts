import { beforeEach, describe, expect, it, vi } from 'vitest'
const { from, maybeSingle, eq } = vi.hoisted(() => ({ from: vi.fn(), maybeSingle: vi.fn(), eq: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({ from }) }))
vi.mock('@/lib/reporting/public-view', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/reporting/public-view')>(), publicReportView: () => ({ client: '<script>secret()</script>', title: 'Safe report', caption: 'Results: 5', from: '2026-10-01', to: '2026-10-07' }) }))
import { GET } from './route'
const token = 'a'.repeat(64)
const get = (value = token) => GET(new Request('http://localhost/reports/shared/' + value), { params: Promise.resolve({ token: value }) })
beforeEach(() => { vi.resetAllMocks(); const query = { select: vi.fn().mockReturnThis(), eq, maybeSingle }; from.mockReturnValue(query); eq.mockReturnValue(query) })
describe('public report access', () => {
  it('rejects malformed tokens before querying data', async () => { expect((await get('../other-report')).status).toBe(404); expect(from).not.toHaveBeenCalled() })
  it.each(['revoked', 'expired', 'superseded'])('denies a %s link', async mode => {
    maybeSingle.mockResolvedValueOnce({ data: { report_id: 'report-1', expires_at: mode === 'expired' ? '2000-01-01' : '2099-01-01', revoked_at: mode === 'revoked' ? '2026-10-25' : null } }).mockResolvedValueOnce({ data: { status: 'ready', review_status: mode === 'superseded' ? mode : 'approved', render_data: {} } })
    expect((await get()).status).toBe(404)
  })
  it('loads only the token-bound report, escapes text and prevents caching', async () => {
    maybeSingle.mockResolvedValueOnce({ data: { report_id: 'report-1', expires_at: '2099-01-01', revoked_at: null } }).mockResolvedValueOnce({ data: { status: 'ready', review_status: 'approved', render_data: {} } })
    const response = await get(), html = await response.text()
    expect(eq).toHaveBeenCalledWith('id', 'report-1')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>')
    expect(html).not.toContain('render_data')
  })
})
