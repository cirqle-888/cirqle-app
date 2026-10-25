import { after, NextResponse } from 'next/server'
import { requirePermission } from '@/lib/permissions/check'
import { createAdminClient } from '@/lib/supabase/server'
import { snapshotFingerprint, snapshotProblem } from '@/lib/reporting/snapshot'
import { enqueueReportGeneration } from '@/lib/reporting/orchestrator'
import { processReportJob } from '@/lib/reporting/process-job'
import type { ReportConfig, RenderData } from '@/lib/reporting/types'
export const maxDuration = 60
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('advertising.edit')
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 })
  const body = await req.json().catch(() => null), { id } = await params
  if (typeof body?.summary !== 'string' || !body.summary.trim() || body.summary.length > 3000) return NextResponse.json({ error: 'Enter a summary up to 3,000 characters.' }, { status: 400 })
  const admin = createAdminClient()
  const { data: row } = await admin.from('ad_reports').select('config, render_data, client_id, status, review_status').eq('id', id).maybeSingle()
  if (!row || !row.config || !row.render_data || row.status !== 'ready' || row.review_status === 'superseded') return NextResponse.json({ error: 'Choose a complete current report.' }, { status: 409 })
  const problem = snapshotProblem(row.render_data as RenderData)
  if (problem) return NextResponse.json({ error: problem }, { status: 409 })
  const config: ReportConfig = { ...row.config, reportId: undefined, snapshotId: undefined, allowIncomplete: undefined, recipients: [], supersedesId: id, summaryOverride: body.summary.trim(), generatedBy: guard.employeeId || undefined }
  const snapshot: RenderData = { ...row.render_data, config, ai: { ...row.render_data.ai, executiveSummary: config.summaryOverride } }
  const { data: draft, error } = await admin.from('ad_report_drafts').insert({ client_id: row.client_id, created_by: guard.employeeId || null, config, config_hash: snapshotFingerprint(config), render_data: snapshot }).select('id').single()
  if (error || !draft) return NextResponse.json({ error: 'Could not create revision.' }, { status: 500 })
  try {
    const queued = await enqueueReportGeneration({ ...config, snapshotId: draft.id }, `revision-${id}-${snapshotFingerprint(config)}`)
    after(() => processReportJob(queued.jobId))
    return NextResponse.json(queued, { status: 202 })
  } catch { return NextResponse.json({ error: 'Could not queue revision.' }, { status: 500 }) }
}
