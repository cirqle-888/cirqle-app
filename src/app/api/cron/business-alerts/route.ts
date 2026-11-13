import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { classifyInvoice, latestByInvoice, type ClassifiableInvoice, type FollowupRow } from '@/lib/followups/grouping'
import { notifyAdmins, notifyAdminsBatch } from '@/lib/notifications/create'
import { logCronRun } from '@/lib/cron/log'
import { todayISO } from '@/lib/utils/local-date'
import { loadOwnerCheckInput } from '@/lib/owner-alerts/load'
import { ownerAlertOn } from '@/lib/owner-alerts/switches'
import {
  buildOwnerCheck, daysOverdue, escalationToSend, highestSentStages, isMondayISO, outstandingInr,
  ownerCheckLines, quietClients, stageKey, STAGE_KEY_PREFIX, unsentInvoices,
} from '@/lib/owner-alerts/rules'
import { sendOwnerCheckEmail } from '@/lib/owner-alerts/email'
import { listenerHealth } from '@/lib/whatsapp-listener/rules'

/**
 * Daily business-health alerts (09:00 IST).
 *
 * 1. Invoices that newly became "Urgent" on the Follow-ups page — once ever per
 *    invoice, using the SAME classifier the page uses (lib/followups/grouping.ts).
 * 2. Owner alerts (lib/owner-alerts), each behind its own switch in
 *    Settings → Company → Owner alerts:
 *    · overdue escalation at 7 / 14 / 30 days overdue,
 *    · invoices still unsent 3 days after their date,
 *    · regular clients gone quiet for 3 weeks,
 *    · on Mondays, the owner check: one notification listing everything that
 *      needs a person this week (and optionally an email).
 * 3. A warning when the WhatsApp listener is switched on but has been silent
 *    for a day.
 *
 * Every notification carries an idempotency key, so a re-run on the same day
 * changes nothing. Alerts built from a failed read are skipped, never sent
 * with partial numbers.
 *
 *   GET /api/cron/business-alerts
 *
 * Auth: same shared-secret pattern as the other crons.
 */

/** Per-run cap for escalation and quiet-client alerts, so a backlog drains over a few days instead of in one burst. */
const MAX_PER_RUN = 5

function authorized(req: NextRequest): boolean {
  const token = process.env.CRON_SECRET
  if (!token) return false
  const header = req.headers.get('authorization') || ''
  return header === `Bearer ${token}`
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

async function loadSwitchSettings(admin: SupabaseClient): Promise<Record<string, string>> {
  // Only the owner-alert rows: company_settings also holds large branding blobs.
  const { data } = await admin.from('company_settings').select('key, value').like('key', 'owner_alert_%')
  return Object.fromEntries((data || []).map((r: { key: string; value: string | null }) => [r.key, r.value ?? '']))
}

async function urgentInvoiceAlerts(admin: SupabaseClient): Promise<{ urgentFound: number; notified: number; error?: string }> {
  const { data: invoices, error: invErr } = await admin
    .from('invoices')
    .select('id, invoice_number, status, issue_date, due_date, total_amount, total_amount_inr, client:clients(name)')
    .in('status', ['sent', 'partial', 'overdue'])
  if (invErr) return { urgentFound: 0, notified: 0, error: invErr.message }
  if (!invoices?.length) return { urgentFound: 0, notified: 0 }

  const { data: followups, error: fuErr } = await admin
    .from('invoice_followups')
    .select('id, invoice_id, note, outcome, promised_date, next_followup_date, created_by, created_at')
    .in('invoice_id', invoices.map((i: any) => i.id))
  if (fuErr) return { urgentFound: 0, notified: 0, error: fuErr.message }

  const latestMap = latestByInvoice((followups || []) as FollowupRow[])
  let urgentFound = 0
  let notified = 0
  for (const inv of invoices as (ClassifiableInvoice & { invoice_number: string; total_amount: number | null; total_amount_inr: number | null; client: { name: string } | { name: string }[] | null })[]) {
    if (classifyInvoice(inv, latestMap.get(inv.id)) !== 'urgent') continue
    urgentFound++
    const clientName = Array.isArray(inv.client) ? inv.client[0]?.name : inv.client?.name
    const before = await admin.from('notifications').select('id').eq('source_key', `invoice_overdue:${inv.id}`).limit(1)
    if (before.data?.length) continue // already notified for this invoice, ever

    // Awaited: a detached promise can be cut off when the serverless function returns.
    await notifyAdmins({
      type: 'invoice_overdue',
      title: `Invoice ${inv.invoice_number} needs follow-up — ${clientName || 'client'}`,
      message: `₹${(inv.total_amount_inr ?? inv.total_amount ?? 0).toLocaleString('en-IN')} outstanding.`,
      link: '/dashboard/invoices/follow-ups',
      sourceKey: `invoice_overdue:${inv.id}`,
    })
    notified++
  }
  return { urgentFound, notified }
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const today = todayISO()
  const summary: Record<string, unknown> = { today }
  const problems: string[] = []

  // ── 1. Urgent invoices (original behaviour) ──────────────────────────────
  const urgent = await urgentInvoiceAlerts(admin)
  summary.urgentFound = urgent.urgentFound
  summary.notified = urgent.notified
  if (urgent.error) problems.push(`urgent invoices: ${urgent.error}`)

  // ── 2. Owner alerts ──────────────────────────────────────────────────────
  const settings = await loadSwitchSettings(admin)
  const { input, errors } = await loadOwnerCheckInput(admin, today)
  if (errors.length) { problems.push(...errors); summary.loadErrors = errors }
  const failed = (prefix: string) => errors.some(e => e.startsWith(prefix))
  const invoicesOk = !failed('invoices') && !failed('follow-ups')

  // Overdue escalation
  if (ownerAlertOn(settings, 'owner_alert_overdue_escalation') && invoicesOk) {
    const { data: sentRows, error } = await fetchAll(
      admin.from('notifications').select('source_key').like('source_key', `${STAGE_KEY_PREFIX}%`),
    )
    if (error) {
      problems.push(`escalation history: ${error.message ?? error}`)
    } else {
      const sent = highestSentStages((sentRows || []).map((r: { source_key: string | null }) => r.source_key))
      const due = input.invoices
        .map(inv => ({ inv, stage: escalationToSend(inv, input.latestFollowups.get(inv.id), sent.get(inv.id) ?? 0, today) }))
        .filter(x => x.stage > 0)
        .sort((a, b) => b.stage - a.stage || outstandingInr(b.inv) - outstandingInr(a.inv))
      const batch = due.slice(0, MAX_PER_RUN)
      await notifyAdminsBatch(batch.map(({ inv, stage }) => ({
        type: 'invoice_overdue_stage',
        title: `${inv.invoice_number} is ${daysOverdue(inv, today)} days overdue — ${inv.client_name || 'client'}`,
        message: stage === 30
          ? `${inr(outstandingInr(inv))} outstanding for over a month. Decide the next step: call, pause work, or write off.`
          : `${inr(outstandingInr(inv))} outstanding. Log a follow-up with a promise or chase date to pause these alerts.`,
        link: `/dashboard/invoices?id=${inv.id}`,
        sourceKey: stageKey(inv.id, stage),
      })))
      summary.escalated = batch.length
      summary.escalationsWaiting = due.length - batch.length
    }
  }

  // Invoices not sent
  if (ownerAlertOn(settings, 'owner_alert_unsent_invoices') && !failed('invoices')) {
    const unsent = unsentInvoices(input.invoices, today)
    await notifyAdminsBatch(unsent.map(u => ({
      type: 'invoice_unsent',
      title: `${u.invoiceNumber} is not sent yet — ${u.clientName}`,
      message: `${inr(u.totalInr)}, dated ${u.daysWaiting} days ago. Review and send it.`,
      link: `/dashboard/invoices?id=${u.invoiceId}`,
      sourceKey: `invoice_unsent:${u.invoiceId}`,
    })))
    summary.unsent = unsent.length
  }

  // Clients going quiet
  if (ownerAlertOn(settings, 'owner_alert_quiet_clients') && !failed('tasks') && !failed('clients')) {
    const quiet = quietClients(input.clients, input.tasks, today).slice(0, MAX_PER_RUN)
    await notifyAdminsBatch(quiet.map(q => ({
      type: 'client_quiet',
      title: `${q.clientName} has been quiet for ${q.daysSilent} days`,
      message: `Usually about ${inr(q.monthlyAvgInr)} a month; last job ${q.lastTaskDate}. Worth a call.`,
      link: `/dashboard/clients/${q.clientId}`,
      // A new job followed by another quiet spell is a new episode, so the key carries the last job date.
      sourceKey: `client_quiet:${q.clientId}:${q.lastTaskDate}`,
    })))
    summary.quietClients = quiet.length
  }

  // Monday owner check
  if (ownerAlertOn(settings, 'owner_alert_weekly_check') && isMondayISO(today)) {
    if (errors.length) {
      // A partial read would understate the week. Say so instead of sending false comfort.
      summary.weeklyCheck = 'skipped: incomplete data'
    } else {
      const key = `owner_weekly:${today}`
      const { data: already } = await admin.from('notifications').select('id').eq('source_key', key).limit(1)
      if (already?.length) {
        summary.weeklyCheck = 'already sent'
      } else {
        const check = buildOwnerCheck(input, today)
        const lines = ownerCheckLines(check)
        await notifyAdmins({
          type: 'owner_weekly_check',
          title: check.attentionCount
            ? `Monday owner check: ${check.attentionCount} thing${check.attentionCount === 1 ? '' : 's'} need you`
            : 'Monday owner check: nothing needs you this week',
          message: lines.length ? lines.join(' · ') : 'No overdue, unsent or quiet items.',
          link: '/dashboard/health#owner-check',
          sourceKey: key,
        })
        summary.weeklyCheck = check.attentionCount
        if (ownerAlertOn(settings, 'owner_alert_weekly_email')) {
          summary.weeklyEmail = await sendOwnerCheckEmail(admin, check, lines)
        }
      }
    }
  }

  // WhatsApp listener gone quiet (lib/whatsapp-listener). Always on while the listener
  // is: a dead listener looks exactly like "no requests today", so nobody would notice.
  {
    const { data } = await admin.from('company_settings').select('key, value').like('key', 'whatsapp_listener_%')
    const listener = Object.fromEntries((data || []).map((r: { key: string; value: string | null }) => [r.key, r.value ?? '']))
    const health = listenerHealth(listener, Date.now())
    summary.whatsappListener = health.state
    if (health.state === 'silent' || health.state === 'never') {
      await notifyAdmins({
        type: 'whatsapp_listener_silent',
        title: health.state === 'never'
          ? 'The WhatsApp listener is on but has never received anything'
          : `Nothing from the WhatsApp listener for ${health.hours} hours`,
        message: 'If the client groups were active, the gateway is down or the spare number was logged out. Check OpenWA, and use the share shortcut meanwhile.',
        link: '/dashboard/settings',
        sourceKey: `whatsapp_listener_silent:${today}`,
      })
    }
  }

  const ok = problems.length === 0
  await logCronRun(admin, 'business-alerts', ok, summary, ok ? undefined : problems.join('; ').slice(0, 500))
  return NextResponse.json({ ok, ...summary, ...(ok ? {} : { errors: problems }) }, { status: ok ? 200 : 500 })
}
