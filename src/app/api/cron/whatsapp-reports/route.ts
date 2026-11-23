import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { logCronRun } from '@/lib/cron/log'
import { alertFlyerDeadlines, finishApprovedFlyers } from '@/lib/whatsapp-listener/flyer-desk-run'
import { alertUnanswered, loadListenerContext, sendWeeklyDigest, updateAllReports } from '@/lib/whatsapp-listener/insights-run'
import { syncWhatsAppRequests } from '@/lib/whatsapp-listener/request-sync-run'
import { todayISO } from '@/lib/utils/local-date'
import { autopilotOn } from '@/lib/autopilot/switches'
import { loadAutopilotSettings } from '@/lib/autopilot/run'
import { assignWaitingRequests } from '@/lib/autopilot/assign'

/**
 * WhatsApp daily reports (19:30 IST).
 *
 * Reads the day's new messages in every allow-listed chat, writes the daily
 * summary and the open "pending" items, and tells the responsible person
 * inside Cirqle about anything new that is waiting on Cirqle. It then nudges
 * about clients who wrote last and got no reply and about offer flyers due
 * by tomorrow that have no finished design, and on Mondays sends the
 * admins a one-line summary of the week. Last, WhatsApp requests that were
 * answered in the chat or came from a Cirqle number are archived
 * (lib/whatsapp-listener/request-sync.ts).
 * Rules: lib/whatsapp-listener/insights.ts. Nothing is sent to WhatsApp.
 *
 * It also runs the autopilot's evening pass of "give requests to the right
 * designer" (lib/autopilot/assign.ts), first because it is quick, so the
 * day's WhatsApp requests do not wait for the morning run.
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
    const autopilot = await loadAutopilotSettings(admin).catch(() => ({} as Record<string, string>))
    const assigned = autopilotOn(autopilot, 'autopilot_assign_requests')
      ? await assignWaitingRequests(admin, todayISO(), { runKey: 'pm' }).catch(e => ({ ok: false, error: String(e) }))
      : 'off'
    const run = await updateAllReports(admin, { budgetMs: 230_000 })
    // End-of-day nudges. Neither may fail the run: the reports are already stored.
    const ctx = await loadListenerContext(admin)
    const waiting = await alertUnanswered(admin, ctx).catch(() => 0)
    // Catches an approval the webhook could not act on at the time.
    const approved = await finishApprovedFlyers(admin, ctx).catch(() => 0)
    const flyers = await alertFlyerDeadlines(admin, ctx).catch(() => 0)
    const weekly = await sendWeeklyDigest(admin, ctx).catch(() => false)
    // WhatsApp requests that were answered in the chat, or came from a Cirqle number, leave the inbox.
    const synced = await syncWhatsAppRequests(admin, ctx.settings).catch(() => null)
    const ok = run.failed === 0
    await logCronRun(admin, 'whatsapp-reports', ok, { ...run, waiting, flyers, approved, weekly, assigned, synced }, ok ? undefined : run.errors.join(' | '))
    return NextResponse.json({ ok, ...run, waiting, flyers, approved, weekly, assigned, synced })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed'
    await logCronRun(admin, 'whatsapp-reports', false, undefined, message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
