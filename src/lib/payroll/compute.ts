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

  // 1) Task-linked scores: find this month's task ids, then sum their scores.
  const { data: monthTasks, error: tasksErr } = await admin
    .from('tasks')
    .select('id')
    .gte('task_date', monthStart)
    .lt('task_date', nextMonthStart)
    .is('deleted_at', null)
  if (tasksErr) return { ok: false, error: tasksErr.message }

  const taskIds = (monthTasks ?? []).map((t: any) => t.id)
  if (taskIds.length > 0) {
    const CHUNK = 200
    for (let i = 0; i < taskIds.length; i += CHUNK) {
      const chunk = taskIds.slice(i, i + CHUNK)
      const { data: scores, error: scoresErr } = await admin
        .from('contribution_scores')
        .select('employee_id, earnings_inr')
        .in('task_id', chunk)
      if (scoresErr) return { ok: false, error: scoresErr.message }
      scores?.forEach((s: any) => {
        commissionByEmployee[s.employee_id] =
          (commissionByEmployee[s.employee_id] || 0) + (s.earnings_inr || 0)
      })
    }
  }

  // 2) Orphan scores (no task_id) — bucketed by calculated_at.
  const { data: orphanScores, error: orphanErr } = await admin
    .from('contribution_scores')
    .select('employee_id, earnings_inr, calculated_at')
    .is('task_id', null)
    .gte('calculated_at', monthStart)
    .lt('calculated_at', nextMonthStart)
  if (orphanErr) return { ok: false, error: orphanErr.message }
  orphanScores?.forEach((s: any) => {
    commissionByEmployee[s.employee_id] =
      (commissionByEmployee[s.employee_id] || 0) + (s.earnings_inr || 0)
  })

  return { ok: true, commissionByEmployee }
}
