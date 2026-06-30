import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { logCronRun } from '@/lib/cron/log'
import { deleteReportStorageAndRow } from '@/lib/reporting/delete-report'

/**
 * Scheduled report-retention cleanup — permanently deletes generated reports
 * (the ad_reports row + every storage object under reports/{id}/) once they are
 * older than the retention window. Reports are delivered to WhatsApp/email, so
 * the database only needs to hold them briefly.
 *
 * Auth: shared-secret `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends
 * this automatically when CRON_SECRET is set). Fails closed.
 *
 *   GET /api/cron/cleanup-reports
 *
 * Retention window defaults to 1 day; override via company_settings key
 * `report_retention_days`. ad_report_analytics rows are removed automatically
 * by ON DELETE CASCADE.
 *
 * Schedule in vercel.json → `crons`.
 */

// Cap per run so a backlog can't blow the serverless time budget.
const MAX_PER_RUN = 500

function authorized(req: NextRequest): boolean {
  const token = process.env.CRON_SECRET
  if (!token) return false // fail closed — never run unauthenticated
  const header = req.headers.get('authorization') || ''
  return header === `Bearer ${token}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  const { data: settingRow } = await admin
    .from('company_settings').select('value').eq('key', 'report_retention_days').maybeSingle()
  const retentionDays = Math.max(1, parseInt(settingRow?.value || '1', 10) || 1)
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()

  const { data: stale, error } = await admin
    .from('ad_reports')
    .select('id')
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(MAX_PER_RUN)

  if (error) {
    await logCronRun(admin, 'cleanup-reports', false, undefined, error.message)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }
  if (!stale?.length) {
    await logCronRun(admin, 'cleanup-reports', true, { deleted: 0, retentionDays })
    return NextResponse.json({ ok: true, deleted: 0, retentionDays })
  }

  let deleted = 0
  let filesRemoved = 0
  const errors: string[] = []

  for (const report of stale) {
    const result = await deleteReportStorageAndRow(admin, report.id)
    filesRemoved += result.filesRemoved
    if (result.error) { errors.push(`${report.id}: ${result.error}`); continue }
    deleted++
  }

  await logCronRun(
    admin,
    'cleanup-reports',
    errors.length === 0,
    { deleted, filesRemoved, retentionDays, scanned: stale.length },
    errors.length ? errors.slice(0, 10).join('; ') : undefined,
  )
  return NextResponse.json({
    ok: errors.length === 0,
    deleted,
    filesRemoved,
    retentionDays,
    errors: errors.length ? errors.slice(0, 10) : undefined,
  })
}
