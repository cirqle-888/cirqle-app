import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/permissions/check'
import { createAdminClient } from '@/lib/supabase/server'
import { issueReportToken } from '@/lib/reporting/public-view'
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('advertising.edit')
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 })
  const { id } = await params
  const admin = createAdminClient()
  const { data: report } = await admin.from('ad_reports').select('id, status, review_status').eq('id', id).maybeSingle()
  if (!report || report.status !== 'ready' || report.review_status !== 'approved') return NextResponse.json({ error: 'Approve a complete report before sharing.' }, { status: 409 })
  const body = await req.json().catch(() => ({}))
  const days = body.days ?? 7
  if (![1, 7, 30].includes(days)) return NextResponse.json({ error: 'Choose 1, 7 or 30 days.' }, { status: 400 })
  const { token, hash } = issueReportToken()
  const expires = new Date(Date.now() + days * 86400000).toISOString()
  const { error } = await admin.from('ad_report_shares').insert({ report_id: id, token_hash: hash, created_by: guard.employeeId || null, expires_at: expires })
  if (error) return NextResponse.json({ error: 'Could not create link.' }, { status: 500 })
  return NextResponse.json({ path: `/reports/shared/${token}`, expiresAt: expires }, { headers: { 'Cache-Control': 'private, no-store' } })
}
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('advertising.edit')
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 })
  const { id } = await params
  const { error } = await createAdminClient().from('ad_report_shares').update({ revoked_at: new Date().toISOString() }).eq('report_id', id).is('revoked_at', null)
  return NextResponse.json(error ? { error: 'Could not revoke links.' } : { ok: true }, { status: error ? 500 : 200 })
}
