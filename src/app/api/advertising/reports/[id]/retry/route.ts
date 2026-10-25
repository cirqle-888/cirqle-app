import { after, NextResponse } from 'next/server'
import { requirePermission } from '@/lib/permissions/check'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveReportScope } from '@/lib/reporting/config'
import { processReportJob } from '@/lib/reporting/process-job'
export const maxDuration = 60
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission('advertising.edit')
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 })
  const { id } = await params
  const admin = createAdminClient()
  const { data: report } = await admin.from('ad_reports').select('project_id, client_id').eq('id', id).maybeSingle()
  if (!report) return NextResponse.json({ error: 'Report not found.' }, { status: 404 })
  const scope = await resolveReportScope(admin, report.project_id, report.client_id)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: 403 })
  const { data, error } = await admin.rpc('retry_ad_report', { p_report_id: id })
  if (error || !data) return NextResponse.json({ error: 'This report cannot be retried. Create a new report instead.' }, { status: 409 })
  after(() => processReportJob(data.jobId))
  return NextResponse.json(data, { status: 202 })
}
