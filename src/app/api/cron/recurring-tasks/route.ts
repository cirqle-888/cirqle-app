import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getNextOccurrence, shouldGenerateNext } from '@/lib/utils/recurring'
import { nextTaskNumber } from '@/lib/utils/task-code'
import { notifyAdmins } from '@/lib/notifications/create'
import { logCronRun } from '@/lib/cron/log'
import { parseBillingRule, isRuleDormant } from '@/lib/tasks/derived-billing'
import { recomputeDerivedTask } from '@/lib/tasks/derived-billing-sync'
import { todayISO } from '@/lib/utils/local-date'
import { autoLinkTaskPackage } from '@/lib/packages/auto-link'

/**
 * Recurring-task JUST-IN-TIME generation cron.
 *
 * Deliberately does NOT pre-generate future occurrences. A recurring series'
 * parent task only ever produces the NEXT occurrence once that occurrence's
 * own scheduled date has arrived — never earlier. This keeps the database and
 * every task list (admin + employee) free of months of not-yet-actionable
 * future clutter; "Tasks" only ever shows real, current/overdue work.
 *
 * Runs DAILY. For each active recurring series, walks forward from the
 * latest known occurrence (parent or last generated instance) one interval
 * step at a time, creating an instance for every scheduled date that has
 * now arrived (<= today) — this is a catch-up, not a forward top-up: if the
 * cron was down for a few days, it creates the occurrences that were due on
 * their OWN scheduled dates (not bunched onto today), capped per series so a
 * long-dead cron can't flood the table on its first run back.
 *
 * New instances mirror the PARENT task's CURRENT title/description/client/
 * service/pricing/currency/quantity (so a rename or re-price on the parent
 * propagates forward) and carry no assignee and no contribution slots —
 * tasks don't have an assignee column (only task_requests does), so there is
 * no per-occurrence assignee to notify; this notifies admins instead, same
 * as the other crons.
 *
 *   GET /api/cron/recurring-tasks
 *
 * Auth: same shared-secret pattern as /api/cron/cleanup-product-images.
 * Schedule daily in vercel.json.
 */

const MAX_CATCHUP_PER_SERIES = 31 // one month of daily-interval downtime, worst case
const MAX_TOTAL_PER_RUN = 500

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
  const todayStr = todayISO()

  // Active recurring series — the parent row itself, not its instances.
  const { data: parents, error: parentsErr } = await admin
    .from('tasks')
    .select('id, title, description, client_id, service_id, billing_amount, billing_amount_inr, currency, quantity, task_date, recurring_interval, recurring_end_date, billing_mode, billing_rule')
    .eq('is_recurring', true)
    .is('deleted_at', null)
    .neq('status', 'cancelled')

  if (parentsErr) {
    await logCronRun(admin, 'recurring-tasks', false, undefined, parentsErr.message)
    return NextResponse.json({ ok: false, error: parentsErr.message }, { status: 500 })
  }
  if (!parents?.length) {
    await logCronRun(admin, 'recurring-tasks', true, { seriesChecked: 0, instancesGenerated: 0 })
    return NextResponse.json({ ok: true, seriesChecked: 0, instancesGenerated: 0 })
  }

  // One shared task_number counter across the whole run.
  const maxRow = await admin.from('tasks').select('task_number').order('task_number', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
  let nextNumber = nextTaskNumber(maxRow.data?.task_number)

  let totalGenerated = 0
  const seriesGenerated: { parentId: string; title: string; count: number; dates: string[] }[] = []
  const errors: string[] = []

  for (const parent of parents) {
    if (totalGenerated >= MAX_TOTAL_PER_RUN) break
    if (!parent.recurring_interval) continue

    // Latest known task_date in this series (parent + every generated instance).
    const { data: latestRows, error: latestErr } = await admin
      .from('tasks')
      .select('task_date')
      .or(`id.eq.${parent.id},recurring_parent_id.eq.${parent.id}`)
      .is('deleted_at', null)
      .order('task_date', { ascending: false })
      .limit(1)
    if (latestErr) { errors.push(`${parent.id}: ${latestErr.message}`); continue }
    const latestDate = latestRows?.[0]?.task_date || parent.task_date

    const effectiveEnd = parent.recurring_end_date || null
    let cursor = getNextOccurrence(latestDate, parent.recurring_interval)
    const dates: string[] = []

    // Walk forward only through dates that have ALREADY arrived (<= today) —
    // this is the JIT rule. Stops the moment the next due date is in the
    // future, leaving it ungenerated until its own day comes.
    while (
      cursor <= todayStr &&
      (!effectiveEnd || shouldGenerateNext({ recurring_end_date: effectiveEnd }, cursor)) &&
      dates.length < MAX_CATCHUP_PER_SERIES &&
      totalGenerated + dates.length < MAX_TOTAL_PER_RUN
    ) {
      dates.push(cursor)
      cursor = getNextOccurrence(cursor, parent.recurring_interval)
    }

    if (dates.length === 0) continue

    // A recurring DERIVED task is a standing billing rule ("Handling = 30% of
    // posters, every month"). Each occurrence carries the rule and prices
    // itself from ITS OWN month — copying the parent's amount would bill every
    // month at the first month's figure.
    const parentRule = parseBillingRule((parent as { billing_rule?: unknown }).billing_rule)
    const derived = (parent as { billing_mode?: string | null }).billing_mode === 'percent_of_services'
      && parentRule.ok
    // Paused or archived rules stop producing occurrences — that is what
    // pausing means, and it is why archiving beats deleting.
    if (derived && parentRule.ok && isRuleDormant(parentRule.rule)) continue

    const instances = dates.map(d => ({
      task_number: nextNumber++,
      title: parent.title,
      description: parent.description || null,
      client_id: parent.client_id,
      service_id: parent.service_id,
      status: 'pending',
      billing_amount: derived ? 0 : parent.billing_amount,
      billing_amount_inr: derived ? 0 : parent.billing_amount_inr,
      quantity: derived ? 1 : (parent.quantity || 1),
      currency: parent.currency || 'INR',
      task_date: d,
      is_recurring: false,
      recurring_parent_id: parent.id,
      ...(derived
        ? { billing_mode: 'percent_of_services', billing_rule: (parent as { billing_rule?: unknown }).billing_rule }
        : {}),
    }))

    const { data: inserted, error: insertErr } = await admin.from('tasks').insert(instances).select('id')
    if (insertErr) { errors.push(`${parent.id}: ${insertErr.message}`); continue }
    totalGenerated += instances.length

    // Each occurrence joins the client's package on its OWN date — a retainer
    // that starts in September must not swallow August's occurrence, and one
    // that has ended must not keep swallowing new ones.
    for (const row of (inserted ?? []) as { id: string }[]) {
      await autoLinkTaskPackage(admin, row.id)
    }

    // Price each new derived occurrence from its own month's sources.
    if (derived) {
      for (const row of (inserted ?? []) as { id: string }[]) {
        try {
          await recomputeDerivedTask(admin as never, row.id, 'monthly occurrence generated')
        } catch { /* the occurrence exists; it will price on the next source edit */ }
      }
    }
    seriesGenerated.push({ parentId: parent.id, title: parent.title, count: instances.length, dates })
  }

  if (totalGenerated > 0) {
    const summary = seriesGenerated.map(s => `${s.title} (${s.dates.join(', ')})`).join('; ')
    void notifyAdmins({
      type: 'recurring_tasks_generated',
      title: `${totalGenerated} recurring task${totalGenerated === 1 ? '' : 's'} created — due today`,
      message: summary,
      link: '/dashboard/tasks',
      sourceKey: `recurring_jit:${todayStr}`,
    })
  }

  await logCronRun(
    admin, 'recurring-tasks', errors.length === 0,
    { seriesChecked: parents.length, instancesGenerated: totalGenerated },
    errors.length ? errors.join('; ') : undefined,
  )
  return NextResponse.json({
    ok: errors.length === 0,
    seriesChecked: parents.length,
    instancesGenerated: totalGenerated,
    seriesGenerated,
    errors: errors.length ? errors : undefined,
  })
}
