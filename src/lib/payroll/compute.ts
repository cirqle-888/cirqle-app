/**
 * Shared monthly-commission computation — extracted out of
 * recalculatePayrollForMonth (dashboard/payroll/actions.ts) so the new
 * payroll-draft cron can use the exact same math instead of re-deriving it.
 *
 * Sums contribution_scores.earnings_inr for a month two ways, matching the
 * payroll client's own `monthCommissions`:
 *   1. Scores linked to a task → bucketed by that task's task_date.
 *   2. Orphan scores (no task_id, e.g. earnings-only CSV imports) →
 *      bucketed by their own calculated_at.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAll, fetchAllIn } from '@/lib/supabase/server'

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * Payroll states that FINALIZE a month. Once any payslip for a month reaches
 * one of these, that month's earnings ledger is history and must never be
 * recomputed — the payslip has been issued and, for 'paid', money has moved.
 */
const FINALIZED_PAYROLL_STATUSES = ['paid'] as const

/**
 * True when a month's books are closed, by EITHER of two independent signals:
 *
 *   1. Any payslip for the month reached a finalized status (money moved).
 *   2. The owner explicitly locked the period (`period_locks`, migration
 *      20260807090000) — "close the books" without waiting for payroll.
 *
 * Every money writer in the app funnels through this one predicate, so adding
 * the second signal here freezes them all consistently — no writer had to
 * change.
 *
 * Fails CLOSED: if either check errors we report the month as finalized,
 * because wrongly skipping a refresh only leaves a cache stale (recoverable),
 * while wrongly rewriting a paid month silently rewrites issued payslips
 * (not recoverable).
 */
export async function isMonthFinalized(
  admin: SupabaseClient,
  month: number,
  year: number,
): Promise<boolean> {
  const { data, error } = await admin
    .from('payroll')
    .select('id, status')
    .eq('month', month)
    .eq('year', year)
    .in('status', FINALIZED_PAYROLL_STATUSES as unknown as string[])
    .limit(1)
  if (error) return true
  if ((data?.length ?? 0) > 0) return true

  // Explicit lock. A MISSING TABLE IS NOT A LOCK: pre-migration environments
  // must keep behaving exactly as before, so only a real read failure on an
  // existing table fails closed. PostgREST reports an absent relation as
  // PGRST205 / 42P01, which we treat as "feature not installed".
  try {
    const { data: lock, error: lockErr } = await admin
      .from('period_locks')
      .select('id')
      .eq('month', month)
      .eq('year', year)
      .limit(1)
    if (lockErr) {
      const code = (lockErr as { code?: string }).code ?? ''
      const msg = (lockErr as { message?: string }).message ?? ''
      const missing = code === 'PGRST205' || code === '42P01' || /does not exist/i.test(msg)
      return !missing
    }
    return (lock?.length ?? 0) > 0
  } catch {
    return false // network/client throw — payroll status above already checked
  }
}

/**
 * True when a task's earnings must not be rewritten — either its month's
 * payroll is finalized, or its date cannot be read.
 *
 * Fails CLOSED on a null or malformed task_date. The earlier inline form,
 * `if (task_date) { const [y,m] = …; if (y && m && await isMonthFinalized(…)) }`,
 * claimed this in a comment but did the opposite: a null date skipped the
 * block entirely and a non-ISO date produced NaN, so both fell through and
 * wrote UNGUARDED. Currently unreachable (task_date is NOT NULL DEFAULT
 * CURRENT_DATE and PostgREST always serializes DATE as YYYY-MM-DD), but the
 * shape was one schema change away from live.
 */
export async function isTaskMonthProtected(
  admin: SupabaseClient,
  taskDate: string | null | undefined,
): Promise<boolean> {
  const [y, m] = String(taskDate ?? '').split('-').map(Number)
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return true
  return await isMonthFinalized(admin, m, y)
}

/**
 * Bring the month's CACHED `contribution_scores.earnings_inr` back in line
 * with CURRENT billing before payroll sums it.
 *
 * Why: payroll sums the cached value, but the Contribution Analysis report
 * recomputes live (`remainingPool × score% × rating%` from current billing /
 * commission% / rating). Any task whose billing, pricing, tools, or rating
 * changed after contributions were saved leaves the cache stale — so payroll
 * silently drifts from the report, and the ⚡ "Recalculate" button used to
 * just re-sum the same stale numbers.
 *
 * SAFETY (same rules as refreshStoredEarningsFromBilling / the engine):
 *  - only rows with score_percentage > 0 are recomputed — earnings-only
 *    imports (score% = 0, flat ₹ amount) are NEVER touched;
 *  - manual-override rows are left exactly as the admin set them.
 */
export async function refreshMonthStoredEarnings(
  admin: SupabaseClient,
  monthStart: string,
  nextMonthStart: string,
  opts: { skipFinalizedCheck?: boolean } = {},
): Promise<{ refreshed: number; skipped?: 'finalized' }> {
  // HISTORICAL EARNINGS PROTECTION.
  // This function REWRITES contribution_scores.earnings_inr. The payroll
  // status guards elsewhere (payroll/actions.ts: `.eq('status','pending')`
  // and the 'Cannot refresh a paid payroll record' check) protect the payroll
  // TABLE only — they do not protect this ledger. Without the check below, a
  // task edit or the monthly cron would silently rewrite earnings for a month
  // whose payslips were already issued and paid, so payroll and the
  // Contribution Analysis report would permanently disagree.
  if (!opts.skipFinalizedCheck) {
    const [y, m] = monthStart.split('-').map(Number)
    if (await isMonthFinalized(admin, m, y)) return { refreshed: 0, skipped: 'finalized' }
  }

  const { data: tasks } = await fetchAll(
    admin
      .from('tasks')
      .select('id, billing_amount_inr, client_id, service_id')
      .gte('task_date', monthStart)
      .lt('task_date', nextMonthStart)
      .is('deleted_at', null)
      .order('id')
  )
  if (!tasks || tasks.length === 0) return { refreshed: 0 }
  const taskById = new Map(tasks.map((t: any) => [t.id, t]))
  const taskIds = tasks.map((t: any) => t.id)

  // Scores worth recomputing: score% > 0 and not manually overridden.
  //
  // Chunked AND paged: chunking alone bounds the URL but not the response, and
  // one chunk of tasks can match more than 1,000 scores once a task carries
  // several contributors. A score missing from this read keeps its stale
  // earnings while the refresh reports success.
  const { data: scoreRows } = await fetchAllIn(
    ids => admin
      .from('contribution_scores')
      .select('task_id, employee_id, score_percentage, earnings_inr, is_manual_override')
      .in('task_id', ids)
      .gt('score_percentage', 0)
      .order('task_id'),
    taskIds,
  )
  const scores = scoreRows.filter((s: any) => !s.is_manual_override)
  if (scores.length === 0) return { refreshed: 0 }

  // Reference data — mirrors buildAnalysisRows (the report) exactly.
  //
  // HISTORICAL READER CONTRACT — DELIBERATE: no `.eq('is_active', true)` here.
  // `is_active` governs what a client may be SOLD today; it must never govern
  // what was EARNED. A deactivated commitment still has to resolve its
  // historical commission_percentage, or every past task on that pair silently
  // reprices to the 50% fallback. Adding an is_active filter here would rewrite
  // earnings across every deactivated pair. Covered by compute.test.ts.
  const [pricingRes, empRes, taskToolsRes, toolsRes] = await Promise.all([
    fetchAll(admin.from('client_service_pricing').select('client_id, service_id, commission_percentage').order('client_id').order('service_id')),
    admin.from('employees').select('id, performance_rating'),
    fetchAllIn(
      ids => admin.from('task_tools').select('task_id, tool_id').in('task_id', ids).order('task_id'),
      taskIds,
    ),
    admin.from('tools').select('id, fixed_percentage, is_active'),
  ])
  const pmap = new Map((pricingRes.data || []).map((p: any) => [`${p.client_id}|${p.service_id}`, p.commission_percentage]))
  const rating = new Map((empRes.data || []).map((e: any) => [e.id, Number(e.performance_rating) || 100]))
  const toolPctById = new Map((toolsRes.data || []).map((t: any) => [t.id, t.is_active !== false ? Number(t.fixed_percentage) || 0 : 0]))
  const toolPctByTask = new Map<string, number>()
  for (const tt of (taskToolsRes.data || []) as any[]) {
    toolPctByTask.set(tt.task_id, (toolPctByTask.get(tt.task_id) || 0) + (toolPctById.get(tt.tool_id) || 0))
  }

  let refreshed = 0
  for (const s of scores) {
    const t: any = taskById.get(s.task_id)
    if (!t) continue
    const commPct = (t.client_id && t.service_id)
      ? (pmap.get(`${t.client_id}|${t.service_id}`) ?? 50)
      : 50
    const pool = (t.billing_amount_inr || 0) * commPct / 100
    const remainingPool = pool * (1 - (toolPctByTask.get(t.id) || 0) / 100)
    const newEarn = r2(remainingPool * (s.score_percentage / 100) * ((rating.get(s.employee_id) ?? 100) / 100))
    if (Math.abs((s.earnings_inr || 0) - newEarn) > 0.01) {
      const { error } = await admin
        .from('contribution_scores')
        .update({ earnings_inr: newEarn })
        .eq('task_id', s.task_id)
        .eq('employee_id', s.employee_id)
      if (!error) { refreshed++ }
    }
  }

  return { refreshed }
}

export async function computeMonthlyCommissions(
  admin: SupabaseClient,
  month: number,
  year: number,
): Promise<{ ok: true; commissionByEmployee: Record<string, number> } | { ok: false; error: string }> {
  const monthStr = `${year}-${String(month).padStart(2, '0')}`
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year
  const nextMonthStr = `${nextYear}-${String(nextMonth).padStart(2, '0')}`
  const monthStart = `${monthStr}-01`
  const nextMonthStart = `${nextMonthStr}-01`

  const commissionByEmployee: Record<string, number> = {}

  // 0) Re-sync the month's cached earnings with current billing FIRST, so the
  // sums below (and therefore payroll) match the Contribution Analysis report.
  // Best-effort: a refresh failure must not block payroll math.
  try {
    await refreshMonthStoredEarnings(admin, monthStart, nextMonthStart)
  } catch (e) {
    console.error('[payroll] earnings refresh failed (continuing with cached values):', e)
  }

  // 1) Task-linked scores: find this month's task ids, then sum their scores.
  // Every read below is paged and every error is propagated. This function
  // decides what people are paid, so a short read is not a degraded result —
  // it is a wrong one, and it under-pays whoever's rows went missing. Failing
  // the whole computation is the only safe response.
  const { data: monthTasks, error: tasksErr } = await fetchAll(
    admin
      .from('tasks')
      .select('id')
      .gte('task_date', monthStart)
      .lt('task_date', nextMonthStart)
      .is('deleted_at', null)
      .order('id')
  )
  if (tasksErr) return { ok: false, error: tasksErr.message }

  const taskIds = (monthTasks ?? []).map((t: any) => t.id)
  if (taskIds.length > 0) {
    const { data: scores, error: scoresErr } = await fetchAllIn(
      ids => admin
        .from('contribution_scores')
        .select('employee_id, earnings_inr')
        .in('task_id', ids)
        .order('task_id'),
      taskIds,
    )
    if (scoresErr) return { ok: false, error: scoresErr.message }
    scores.forEach((s: any) => {
      commissionByEmployee[s.employee_id] =
        (commissionByEmployee[s.employee_id] || 0) + (s.earnings_inr || 0)
    })
  }

  // 2) Orphan scores (no task_id) — bucketed by calculated_at.
  const { data: orphanScores, error: orphanErr } = await fetchAll(
    admin
      .from('contribution_scores')
      .select('employee_id, earnings_inr, calculated_at')
      .is('task_id', null)
      .gte('calculated_at', monthStart)
      .lt('calculated_at', nextMonthStart)
      .order('calculated_at')
  )
  if (orphanErr) return { ok: false, error: orphanErr.message }
  orphanScores?.forEach((s: any) => {
    commissionByEmployee[s.employee_id] =
      (commissionByEmployee[s.employee_id] || 0) + (s.earnings_inr || 0)
  })

  return { ok: true, commissionByEmployee }
}
