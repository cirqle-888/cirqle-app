/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const send = vi.fn()
vi.mock('@/lib/email/resend', () => ({ getResend: () => (process.env.__NO_RESEND ? null : { emails: { send } }) }))
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

import { storageKeyFromStoredUrl, sendReportEmail } from './delivery-engine'

const SB = 'https://abc.supabase.co'
const id = '11111111-2222-3333-4444-555555555555'

describe('storageKeyFromStoredUrl', () => {
  it('recovers the key from our own signed URL', () => {
    const url = `${SB}/storage/v1/object/sign/ad-reports/reports/${id}/pdf/My-Report-20261001.pdf?token=x`
    expect(storageKeyFromStoredUrl(url, id, SB)).toBe(`reports/${id}/pdf/My-Report-20261001.pdf`)
  })
  it('rejects other origins, buckets, reports and traversal', () => {
    expect(storageKeyFromStoredUrl(`https://evil.example/storage/v1/object/sign/ad-reports/reports/${id}/a.pdf`, id, SB)).toBeNull()
    expect(storageKeyFromStoredUrl(`${SB}/storage/v1/object/sign/other/reports/${id}/a.pdf`, id, SB)).toBeNull()
    expect(storageKeyFromStoredUrl(`${SB}/storage/v1/object/sign/ad-reports/reports/other-id/a.pdf`, id, SB)).toBeNull()
    expect(storageKeyFromStoredUrl(`${SB}/storage/v1/object/sign/ad-reports/reports/${id}/../x/a.pdf`, id, SB)).toBeNull()
    expect(storageKeyFromStoredUrl(null, id, SB)).toBeNull()
  })
})

const data: any = {
  brand: { agencyName: 'Cirqle <b>', primaryColor: '#6D28D9', showPoweredBy: false },
  project: { campaignName: '<script>x</script>' },
  template: { displayName: 'Daily' },
  config: { dateFrom: '2026-10-01', dateTo: '2026-10-07' },
  kpi: { primary: { spend: 1, revenue: 0, roas: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, leads: 0, cpl: 0 }, derived: {} },
  health: { score: 50, grade: 'F' },
  ai: { executiveSummary: '<img src=x onerror=alert(1)>' },
}
const exp = [{ format: 'pdf', storageKey: 'k', publicUrl: 'https://abc.supabase.co/x.pdf', sizeBytes: 1 }] as any

describe('sendReportEmail', () => {
  beforeEach(() => { send.mockReset(); delete process.env.__NO_RESEND })

  it('a RETURNED provider error is a failure, not a delivery', async () => {
    send.mockResolvedValue({ data: null, error: { message: 'domain not verified' } })
    const r = await sendReportEmail(data, exp, [{ email: 'a@x.com' }])
    expect(r.accepted).toEqual([])
    expect(r.failed[0]).toMatchObject({ email: 'a@x.com', error: 'domain not verified' })
  })

  it('acceptance records the provider id; attachments use `path`', async () => {
    send.mockResolvedValue({ data: { id: 'msg_1' }, error: null })
    const r = await sendReportEmail(data, exp, [{ email: 'a@x.com' }])
    expect(r.accepted).toEqual([{ email: 'a@x.com', providerId: 'msg_1' }])
    expect(send.mock.calls[0][0].attachments).toEqual([{ filename: 'Report.pdf', path: exp[0].publicUrl }])
  })

  it('escapes interpolated text', async () => {
    send.mockResolvedValue({ data: { id: 'm' }, error: null })
    await sendReportEmail(data, exp, [{ email: 'a@x.com' }])
    const html: string = send.mock.calls[0][0].html
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;script&gt;')
  })

  it('missing configuration or files fails every recipient', async () => {
    process.env.__NO_RESEND = '1'
    expect((await sendReportEmail(data, exp, [{ email: 'a@x.com' }])).failed).toHaveLength(1)
    delete process.env.__NO_RESEND
    expect((await sendReportEmail(data, [], [{ email: 'a@x.com' }])).failed).toHaveLength(1)
    expect(send).not.toHaveBeenCalled()
  })
})
