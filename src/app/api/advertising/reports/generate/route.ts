/** Queue a stable report run and wake its worker after the 202 response. */

import { after, NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '@/lib/permissions/check'
import { createAdminClient } from '@/lib/supabase/server'
import { enqueueReportGeneration } from '@/lib/reporting/orchestrator'
import { parseReportRequest, resolveScopeFor } from '@/lib/reporting/config'
import { processReportJob } from '@/lib/reporting/process-job'
import { snapshotFingerprint, snapshotProblem } from '@/lib/reporting/snapshot'
import type { RenderData, ReportConfig } from '@/lib/reporting/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // Vercel max for Hobby plan

export async function POST(req: NextRequest) {
  try {
    const guard = await requirePermission('advertising.edit')
    if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 })

    const body = await req.json().catch(() => null)
    const parsed = parseReportRequest(body)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const scope = await resolveScopeFor(createAdminClient(), parsed.value, body?.clientId)
    if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: 400 })

    const config: ReportConfig = {
      ...parsed.value,
      clientId:    scope.value.clientId,
      generatedBy: guard.employeeId || undefined,
    }

    if (!config.snapshotId) return NextResponse.json({ error: 'Preview and approve the report before generating.' }, { status: 400 })
    const { data: draft } = await createAdminClient().from('ad_report_drafts').select('*').eq('id', config.snapshotId).maybeSingle()
    if (!draft || draft.client_id !== config.clientId || draft.created_by !== (guard.employeeId || null)
      || Date.parse(draft.expires_at) <= Date.now() || draft.config_hash !== snapshotFingerprint(config)) {
      return NextResponse.json({ error: 'Preview expired or settings changed. Refresh the preview.' }, { status: 409 })
    }
    const problem = snapshotProblem(draft.render_data as RenderData)
    if (problem && !config.allowIncomplete) return NextResponse.json({ error: problem }, { status: 409 })
    if (config.allowIncomplete && config.recipients?.length) return NextResponse.json({ error: 'Incomplete drafts cannot be emailed.' }, { status: 400 })

    const requestKey = req.headers.get('Idempotency-Key')
    if (requestKey && !/^[a-zA-Z0-9_-]{16,100}$/.test(requestKey)) {
      return NextResponse.json({ error: 'Invalid request ID.' }, { status: 400 })
    }
    const queued = await enqueueReportGeneration(config, requestKey ?? undefined)
    after(() => processReportJob(queued.jobId))
    return NextResponse.json(queued, { status: 202, headers: { 'Cache-Control': 'private, no-store' } })

  } catch (err) {
    console.error('[API /reports/generate]', err)
    return NextResponse.json({ error: 'Report generation failed. Please try again.' }, { status: 500 })
  }
}
