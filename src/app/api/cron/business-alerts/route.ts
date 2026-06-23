import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { classifyInvoice, latestByInvoice, type ClassifiableInvoice, type FollowupRow } from '@/lib/followups/grouping'
import { notifyAdmins } from '@/lib/notifications/create'
import { logCronRun } from '@/lib/cron/log'

/**
 * Daily business-health alert cron — surfaces invoices that have newly
 * become "Urgent" (overdue, a promised date passed, a scheduled chase came
 * due, or it's gone stale with zero contact) using the SAME classifier the
 * Follow-ups page itself uses (lib/followups/grouping.ts), so this can never
 * drift from what staff see when they open that page.
 *
 * Notifies once EVER per invoice (sourceKey = invoice id, no date suffix) —
 * an invoice that's overdue stays overdue every day until paid, so a daily
 * repeat would just be noise. If it resolves and somehow goes Urgent again
 * later, the unique row from before still blocks a duplicate; that's an
 * acceptable Phase-1 tradeoff over building real transition-tracking state.
 *
 *   GET /api/cron/business-alerts
 *
 * Auth: same shared-secret pattern as the other crons. Schedule daily.
 */

function authorized(req: NextRequest): boolean {
  const token = process.env.CRON_SECRET
  if (!token) return false
  const header = req.headers.get('authorization') || ''
  return header === `Bearer ${token}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  const { data: invoices, error: invErr } = await admin
    .from('invoices')
    .select('id, invoice_number, status, issue_date, due_date, total_amount, total_amount_inr, client:clients(name)')
    .in('status', ['sent', 'partial', 'overdue'])
  if (invErr) {
    await logCronRun(admin, 'business-alerts', false, undefined, invErr.message)
    return NextResponse.json({ ok: false, error: invErr.message }, { status: 500 })
  }
  if (!invoices?.length) {
    await logCronRun(admin, 'business-alerts', true, { urgentFound: 0, notified: 0 })
    return NextResponse.json({ ok: true, urgentFound: 0, notified: 0 })
  }

  const invoiceIds = invoices.map((i: any) => i.id)
  const { data: followups, error: fuErr } = await admin
    .from('invoice_followups')
    .select('id, invoice_id, note, outcome, promised_date, next_followup_date, created_by, created_at')
    .in('invoice_id', invoiceIds)
  if (fuErr) {
    await logCronRun(admin, 'business-alerts', false, undefined, fuErr.message)
    return NextResponse.json({ ok: false, error: fuErr.message }, { status: 500 })
  }

  const latestMap = latestByInvoice((followups || []) as FollowupRow[])

  let urgentFound = 0
  let notified = 0
  for (const inv of invoices as (ClassifiableInvoice & { invoice_number: string; total_amount: number | null; total_amount_inr: number | null; client: { name: string } | { name: string }[] | null })[]) {
    const group = classifyInvoice(inv, latestMap.get(inv.id))
    if (group !== 'urgent') continue
    urgentFound++

    const clientName = Array.isArray(inv.client) ? inv.client[0]?.name : inv.client?.name
    const before = await admin.from('notifications').select('id').eq('source_key', `invoice_overdue:${inv.id}`).limit(1)
    if (before.data?.length) continue // already notified for this invoice, ever

    void notifyAdmins({
      type: 'invoice_overdue',
      title: `Invoice ${inv.invoice_number} needs follow-up — ${clientName || 'client'}`,
      message: `₹${(inv.total_amount_inr ?? inv.total_amount ?? 0).toLocaleString('en-IN')} outstanding.`,
      link: '/dashboard/invoices/follow-ups',
      sourceKey: `invoice_overdue:${inv.id}`,
    })
    notified++
  }

  await logCronRun(admin, 'business-alerts', true, { urgentFound, notified })
  return NextResponse.json({ ok: true, urgentFound, notified })
}
