/**
 * GET /api/cron/report-scheduler
 *
 * Cron job that fires scheduled reports.
 * Polls ad_report_schedules for active schedules where next_run_at <= NOW().
 * Enqueues one advertising_generate_report job per due schedule.
 * Each schedule is CLAIMED before its job is enqueued: next_run_at is advanced
 * with a compare-and-set on the value we read, so two overlapping invocations
 * cannot both enqueue the same run.
 *
 * vercel.json runs this once a day (06:00 UTC) and the general job worker at
 * 04:00 UTC, so a report queued here used to sit ~22 hours before anything
 * picked it up. After enqueueing, this route now drains the queue itself
 * within its own time budget; anything left over is still picked up by the
 * next process-jobs run.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { enqueueReportGeneration } from '@/lib/reporting/orchestrator'
import { computeDateRange, computeComparisonRange, computeNextRun } from '@/lib/reporting/scheduler-utils'
import type { ReportConfig, ReportFormat } from '@/lib/reporting/types'
import { logCronRun } from '@/lib/cron/log'
import { processJobs } from '@/lib/jobs/worker'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Leave headroom under maxDuration for the claim/enqueue pass and logging.
const PROCESS_BUDGET_MS = 240_000

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
    await logCronRun(admin, 'report-scheduler', false, undefined, error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!schedules || schedules.length === 0) {
    await logCronRun(admin, 'report-scheduler', true, { enqueued: 0, note: 'no schedules due' })
    return NextResponse.json({ ok: true, enqueued: 0, message: 'No schedules due' })
  }

  let enqueued = 0
  const errors: string[] = []

  const now = new Date()
  let skipped = 0

  for (const schedule of schedules) {
    try {
      const timeZone = schedule.delivery_timezone || 'UTC'
      const { dateFrom, dateTo } = computeDateRange(schedule.frequency, now, timeZone)
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

      // Claim: advance next_run_at only if nobody else already has. A run that
      // was missed (cron down for days) fires ONCE for the latest period and
      // jumps to the next future boundary — it never replays every missed one.
      const nextRun = computeNextRun(schedule.frequency, schedule.delivery_hour ?? 7, timeZone, now)
      const { data: claimed, error: claimErr } = await admin
        .from('ad_report_schedules')
        .update({ last_run_at: now.toISOString(), next_run_at: nextRun })
        .eq('id', schedule.id)
        .eq('next_run_at', schedule.next_run_at)
        .select('id')
      if (claimErr) throw new Error(`claim failed: ${claimErr.message}`)
      if (!claimed || claimed.length === 0) { skipped++; continue }

      try {
        await enqueueReportGeneration(config)
        enqueued++
      } catch (err) {
        // Release the claim so the next invocation retries this run.
        await admin
          .from('ad_report_schedules')
          .update({ next_run_at: schedule.next_run_at, last_run_at: schedule.last_run_at })
          .eq('id', schedule.id)
          .eq('next_run_at', nextRun)
        throw err
      }
    } catch (err: any) {
      console.error(`[report-scheduler] Schedule ${schedule.id} failed:`, err.message)
      errors.push(`${schedule.id}: ${err.message}`)
    }
  }

  let processed = 0
  if (enqueued > 0) {
    try {
      processed = await processJobs(`report-scheduler-${crypto.randomUUID()}`, PROCESS_BUDGET_MS)
    } catch (err) {
      errors.push(`processJobs: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  await logCronRun(admin, 'report-scheduler', errors.length === 0, {
    enqueued,
    skipped,
    processed,
    total: schedules.length,
  }, errors.length > 0 ? errors.join('; ') : undefined)
  return NextResponse.json({
    ok: true,
    enqueued,
    skipped,
    processed,
    total: schedules.length,
    errors: errors.length > 0 ? errors : undefined,
  })
}
