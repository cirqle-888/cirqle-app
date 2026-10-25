import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/permissions/check'
import { createAdminClient } from '@/lib/supabase/server'
import { sendReportEmail, signDownloadUrl } from '@/lib/reporting/delivery-engine'
import type { ExportResult, RenderData } from '@/lib/reporting/types'
export const maxDuration = 60
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('advertising.edit')
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 })
  const body = await req.json().catch(() => null), { id } = await params
  if (typeof body?.email !== 'string' || body.email.length > 254) return NextResponse.json({ error: 'Choose a saved recipient.' }, { status: 400 })
  const admin = createAdminClient()
  const { data: claim, error } = await admin.rpc('claim_report_delivery', { p_report_id: id, p_email: body.email })
  if (error || !claim) return NextResponse.json({ error: 'This recipient cannot be sent again, or the report needs approval.' }, { status: 409 })
  let exports: ExportResult[]
  try {
    exports = await Promise.all((claim.exports as ExportResult[]).map(async e => ({ ...e, publicUrl: await signDownloadUrl(e.storageKey) })))
  } catch {
    await admin.rpc('finish_report_delivery', { p_report_id: id, p_email: body.email, p_attempt_id: claim.attemptId, p_result: { status: 'failed', error: 'Could not prepare download links. No email was attempted.' } })
    return NextResponse.json({ error: 'Could not prepare download links. Retry when storage is available.' }, { status: 503 })
  }
  try {
    const outcome = await sendReportEmail(claim.renderData as RenderData, exports, [{ email: body.email }], `report-attempt-${claim.attemptId}`)
    const result = outcome.accepted[0] ? { status: 'accepted', providerId: outcome.accepted[0].providerId } : { status: 'failed', error: outcome.failed[0]?.error ?? 'Provider rejected send.' }
    const saved = await admin.rpc('finish_report_delivery', { p_report_id: id, p_email: body.email, p_attempt_id: claim.attemptId, p_result: result })
    if (saved.error) return NextResponse.json({ error: 'Send outcome needs review. Do not resend until checked.' }, { status: 503 })
    return NextResponse.json(result, { status: result.status === 'accepted' ? 200 : 502 })
  } catch {
    // An interrupted external call may already have been accepted. Keep sending,
    // rather than retry automatically and risk a duplicate email.
    return NextResponse.json({ error: 'The send outcome is uncertain. Review the provider before retrying.' }, { status: 503 })
  }
}
