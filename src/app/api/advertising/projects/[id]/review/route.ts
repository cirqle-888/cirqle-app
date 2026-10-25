import { NextResponse } from 'next/server'
import { requirePermission, requireReadPermission } from '@/lib/permissions/check'
import { createAdminClient } from '@/lib/supabase/server'
import { isISODate } from '@/lib/reporting/config'
import { ANNOTATION_KINDS, validBudgetRequest } from '@/lib/advertising/review-validation'
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireReadPermission('advertising.view')
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 })
  const { id } = await params, admin = createAdminClient()
  const { data: project } = await admin.from('ad_projects').select('client_id, provider_metadata').eq('id', id).is('deleted_at', null).maybeSingle()
  if (!project) return NextResponse.json({ error: 'Campaign not found.' }, { status: 404 })
  const [budget, leads, edit, leadEdit] = await Promise.all([requireReadPermission('advertising.manage_budget'), requireReadPermission('leads.view'), requirePermission('advertising.edit'), requirePermission('leads.manage')])
  let budgets = admin.from('ad_budget_requests').select('id, amount, currency, reason, status, expires_at, created_at').eq('project_id', id).order('created_at', { ascending: false }).limit(100)
  if (!budget.ok) budgets = budgets.eq('requested_by', guard.employeeId || '00000000-0000-0000-0000-000000000000')
  const [annotations, requests, metricRows, leadRows] = await Promise.all([
    admin.from('ad_campaign_annotations').select('id, occurred_on, kind, note').eq('project_id', id).order('occurred_on', { ascending: false }).limit(100), budgets,
    admin.from('ad_daily_metrics').select('metric_date, spend').eq('project_id', id).order('metric_date', { ascending: false }).limit(90),
    leads.ok && project.provider_metadata?.campaign_id ? admin.from('leads').select('id, status, enquiry_quality, quality_reason').eq('client_id', project.client_id).eq('campaign_external_id', project.provider_metadata.campaign_id).limit(100) : Promise.resolve({ data: [], error: null }),
  ])
  if (annotations.error || requests.error) return NextResponse.json({ error: 'Campaign review tools are not available yet.' }, { status: 503 })
  return NextResponse.json({ annotations: annotations.data, budgets: requests.data, metrics: (metricRows.data ?? []).reverse(), leads: leadRows.data ?? [], leadsAvailable: leads.ok && !leadRows.error, canEdit: edit.ok, canReviewLeads: leadEdit.ok, canApprove: budget.ok }, { headers: { 'Cache-Control': 'private, no-store' } })
}
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  const permission = body.action === 'decide' ? 'advertising.manage_budget' : body.action === 'lead' ? 'leads.manage' : 'advertising.edit'
  const guard = await requirePermission(permission)
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 })
  const { id } = await params, admin = createAdminClient()
  const { data: project } = await admin.from('ad_projects').select('client_id, provider_metadata').eq('id', id).is('deleted_at', null).maybeSingle()
  if (!project) return NextResponse.json({ error: 'Campaign not found.' }, { status: 404 })
  if (body.action === 'annotation') {
    if (!isISODate(body.date) || !ANNOTATION_KINDS.includes(body.kind) || typeof body.note !== 'string' || !body.note.trim() || body.note.length > 2000) return NextResponse.json({ error: 'Enter a date, change type and note.' }, { status: 400 })
    const { error } = await admin.from('ad_campaign_annotations').insert({ project_id: id, occurred_on: body.date, kind: body.kind, note: body.note.trim(), created_by: guard.employeeId || null })
    return NextResponse.json(error ? { error: 'Could not save annotation.' } : { ok: true }, { status: error ? 500 : 200 })
  }
  if (body.action === 'budget') {
    const invalid = validBudgetRequest(body.amount, body.currency, body.reason)
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })
    const { error } = await admin.from('ad_budget_requests').insert({ project_id: id, amount: body.amount, currency: body.currency, reason: body.reason.trim(), requested_by: guard.employeeId || null, expires_at: new Date(Date.now() + 7 * 86400000).toISOString() })
    return NextResponse.json(error ? { error: 'Could not save request.' } : { ok: true }, { status: error ? 500 : 200 })
  }
  if (body.action === 'decide') {
    if (!['approved', 'rejected'].includes(body.status)) return NextResponse.json({ error: 'Choose approve or reject.' }, { status: 400 })
    const { data, error } = await admin.from('ad_budget_requests').update({ status: body.status, decided_by: guard.employeeId || null, decided_at: new Date().toISOString() }).eq('id', body.requestId).eq('project_id', id).eq('status', 'requested').gt('expires_at', new Date().toISOString()).select('id')
    return NextResponse.json(error || !data?.length ? { error: 'Request expired or has already been decided.' } : { ok: true }, { status: error || !data?.length ? 409 : 200 })
  }
  if (body.action === 'lead') {
    if (!project.provider_metadata?.campaign_id || !['valid', 'invalid'].includes(body.quality) || !['new', 'contacted', 'qualified', 'won', 'lost'].includes(body.status) || typeof body.reason !== 'string' || body.reason.length > 2000) return NextResponse.json({ error: 'Choose enquiry quality and CRM status.' }, { status: 400 })
    const { data, error } = await admin.from('leads').update({ enquiry_quality: body.quality, quality_reason: body.reason, status: body.status, quality_reviewed_by: guard.employeeId || null, quality_reviewed_at: new Date().toISOString() }).eq('id', body.leadId).eq('client_id', project.client_id).eq('campaign_external_id', project.provider_metadata.campaign_id).select('id')
    return NextResponse.json(error || !data?.length ? { error: 'This lead is not linked to this campaign.' } : { ok: true }, { status: error || !data?.length ? 409 : 200 })
  }
  return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
}
