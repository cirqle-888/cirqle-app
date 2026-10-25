import { createAdminClient } from '@/lib/supabase/server'
import { hashReportToken, reportShareAllowed, publicReportView } from '@/lib/reporting/public-view'
import type { RenderData } from '@/lib/reporting/types'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store, max-age=0', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", 'Content-Type': 'text/html; charset=utf-8' }
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const unavailable = () => new Response('This report link is unavailable or expired.', { status: 404, headers })
  if (!/^[a-f0-9]{64}$/.test(token)) return unavailable()
  const admin = createAdminClient()
  const { data: share } = await admin.from('ad_report_shares').select('report_id, expires_at, revoked_at').eq('token_hash', hashReportToken(token)).maybeSingle()
  if (!share) return unavailable()
  const { data: report } = await admin.from('ad_reports').select('status, review_status, render_data').eq('id', share.report_id).maybeSingle()
  if (!report || !reportShareAllowed(report, share) || !report.render_data) return unavailable()
  const view = publicReportView(report.render_data as RenderData)
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Campaign report</title><style>body{font:16px/1.6 system-ui,sans-serif;margin:0;background:#f5f4fa;color:#20202a}main{max-width:760px;margin:32px auto;padding:24px;background:white;border-radius:16px}h1{font-size:26px;overflow-wrap:anywhere}pre{white-space:pre-wrap;font:inherit;overflow-wrap:anywhere}small{color:#666}</style><main><small>${escape(view.client)}</small><h1>${escape(view.title)}</h1><pre>${escape(view.caption)}</pre><small>Approved report · ${escape(view.from)} to ${escape(view.to)}. Read-only view; downloads are not enabled for this link.</small></main></html>`, { headers })
}
