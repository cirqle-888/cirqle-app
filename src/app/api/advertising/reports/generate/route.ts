/**
 * POST /api/advertising/reports/generate
 *
 * Enqueues a report generation job.
 * Returns { jobId, reportId } immediately; the job runs in the background.
 *
 * For synchronous generation (useful for small date ranges / testing),
 * pass ?sync=true — waits for the report to complete before responding.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { generateReport, enqueueReportGeneration } from '@/lib/reporting/orchestrator'
import type { ReportConfig } from '@/lib/reporting/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // Vercel max for Hobby plan

export async function POST(req: NextRequest) {
  try {
    const me = await loadCurrentUser().catch(() => null)

    const body = await req.json() as Partial<ReportConfig>

    // Validate required fields
    if (!body.projectId)  return NextResponse.json({ error: 'Missing projectId' }, { status: 400 })
    if (!body.clientId)   return NextResponse.json({ error: 'Missing clientId' }, { status: 400 })
    if (!body.dateFrom)   return NextResponse.json({ error: 'Missing dateFrom' }, { status: 400 })
    if (!body.dateTo)     return NextResponse.json({ error: 'Missing dateTo' }, { status: 400 })

    const config: ReportConfig = {
      projectId:      body.projectId,
      clientId:       body.clientId,
      reportType:     body.reportType     ?? 'custom',
      template:       body.template       ?? 'performance',
      dateFrom:       body.dateFrom,
      dateTo:         body.dateTo,
      comparisonFrom: body.comparisonFrom,
      comparisonTo:   body.comparisonTo,
      formats:        body.formats?.length ? body.formats : ['pdf'],
      generatedBy:    (me as any)?.id ?? undefined,
      recipients:     body.recipients     ?? [],
    }

    const sync = req.nextUrl.searchParams.get('sync') === 'true'

    if (sync) {
      // Synchronous: run inline (use only for small date ranges or dev)
      const result = await generateReport(config)
      return NextResponse.json(result)
    }

    // Async: enqueue job
    const jobId = await enqueueReportGeneration(config)
    return NextResponse.json({ jobId, status: 'queued' }, { status: 202 })
  } catch (err: any) {
    console.error('[API /reports/generate]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
