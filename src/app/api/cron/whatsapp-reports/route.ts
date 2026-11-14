import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { logCronRun } from '@/lib/cron/log'
import { alertUnanswered, loadListenerContext, sendWeeklyDigest, updateAllReports } from '@/lib/whatsapp-listener/insights-run'

/**
 * WhatsApp daily reports (19:30 IST).
 *
 * Reads the day's new messages in every allow-listed chat, writes the daily
 * summary and the open "pending" items, and tells the responsible person
 * inside Cirqle about anything new that is waiting on Cirqle. It then nudges
 * about clients who wrote last and got no reply, and on Mondays sends the
 * admins a one-line summary of the week.
 * Rules: lib/whatsapp-listener/insights.ts. Nothing is sent to WhatsApp.
 *
 * Safe to re-run: each chat remembers the last message it has read, and each
 * alert carries an idempotency key.
 *
 *   GET /api/cron/whatsapp-reports
 *
 * Auth: same shared-secret pattern as the other crons.
 */

export const maxDuration = 300

function authorized(req: NextRequest): boolean {
  const token = process.env.CRON_SECRET
  if (!token) return false
  return (req.headers.get('authorization') || '') === `Bearer ${token}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  try {
    const run = await updateAllReports(admin, { budgetMs: 240_000 })
    // End-of-day nudges. Neither may fail the run: the reports are already stored.
    const ctx = await loadListenerContext(admin)
    const waiting = await alertUnanswered(admin, ctx).catch(() => 0)
    const weekly = await sendWeeklyDigest(admin, ctx).catch(() => false)
    const ok = run.failed === 0
    await logCronRun(admin, 'whatsapp-reports', ok, { ...run, waiting, weekly }, ok ? undefined : run.errors.join(' | '))
    return NextResponse.json({ ok, ...run, waiting, weekly })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed'
    await logCronRun(admin, 'whatsapp-reports', false, undefined, message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
