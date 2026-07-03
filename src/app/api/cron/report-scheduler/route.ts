/**
 * GET /api/cron/report-scheduler
 *
 * Cron job that fires scheduled reports.
 * Polls ad_report_schedules for active schedules where next_run_at <= NOW().
 * Enqueues one advertising_generate_report job per due schedule.
 * Updates next_run_at and last_run_at after enqueueing.
 *
 * Add to vercel.json crons: { "path": "/api/cron/report-scheduler", "schedule": "0 * * * *" }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { enqueueReportGeneration } from '@/lib/reporting/orchestrator'
import { computeDateRange, computeComparisonRange, computeNextRun } from '@/lib/reporting/scheduler-utils'
import type { ReportConfig, ReportFormat } from '@/lib/reporting/types'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const admin = createAdminClient()

  // Fetch all active schedules due to run now
  const { data: schedules, error } = await admin
    .from('ad_report_schedules')
    .select('*')
    .eq('is_active', true)
    .lte('next_run_at', new Date().toISOString())
    .limit(50)

  if (error) {
    console.error('[report-scheduler] Failed to fetch schedules:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!schedules || schedules.length === 0) {
    return NextResponse.json({ ok: true, enqueued: 0, message: 'No schedules due' })
  }

  let enqueued = 0
  const errors: string[] = []

  for (const schedule of schedules) {
    try {
      const { dateFrom, dateTo } = computeDateRange(schedule.frequency)
      const { comparisonFrom, comparisonTo } = computeComparisonRange(dateFrom, dateTo)

      const formats = (schedule.formats as ReportFormat[]) ?? ['pdf']
      const recipients = Array.isArray(schedule.recipients) ? schedule.recipients : []

      const config: ReportConfig = {
        projectId:      schedule.project_id,
        clientId:       schedule.client_id,
        reportType:     schedule.report_type,
        template:       schedule.template,
        dateFrom,
        dateTo,
        comparisonFrom: schedule.include_comparison ? comparisonFrom : undefined,
        comparisonTo:   schedule.include_comparison ? comparisonTo : undefined,
        formats,
        recipients,
        scheduleId:     schedule.id,
      }

      await enqueueReportGeneration(config)
      enqueued++

      // Update schedule: advance next_run_at and set last_run_at
      const nextRun = computeNextRun(schedule.frequency, schedule.delivery_hour ?? 7)
      await admin
        .from('ad_report_schedules')
        .update({ last_run_at: new Date().toISOString(), next_run_at: nextRun })
        .eq('id', schedule.id)
    } catch (err: any) {
      console.error(`[report-scheduler] Schedule ${schedule.id} failed:`, err.message)
      errors.push(`${schedule.id}: ${err.message}`)
    }
  }

  return NextResponse.json({
    ok: true,
    enqueued,
    total: schedules.length,
    errors: errors.length > 0 ? errors : undefined,
  })
}
