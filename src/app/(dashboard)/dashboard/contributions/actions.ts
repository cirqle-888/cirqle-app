'use server'

import { syncTaskAgreementEarnings } from '@/lib/sync/agreement-earnings'
import { requireAnyPermission } from '@/lib/permissions/check'
import { createAdminClient } from '@/lib/supabase/admin'
import { PERMS } from '@/lib/permissions/keys'
import { isTaskMonthProtected } from '@/lib/payroll/compute'
import { logActivity } from '@/lib/activity/log'

/**
 * Apply employee commission agreements to a task's stored earnings after the
 * contributions client has saved the base contribution scores. No-op when there
 * are no active agreements (or pre-migration) — so nothing changes for tasks
 * whose contributors have no agreement.
 */
export async function applyTaskAgreements(taskId: string): Promise<{ ok: boolean; changed: number }> {
  try {
    const { changed } = await syncTaskAgreementEarnings(taskId)
    return { ok: true, changed }
  } catch {
    return { ok: false, changed: 0 }
  }
}

// ─── Phase 3.0 — server-side contribution writes ─────────────────────────────

/**
 * The single write path for a task's contributions, scores and tools.
 *
 * Replaces the direct browser writes in contributions-client (manual save and
 * bulk auto-recalc). Those bypassed every guarantee the financial core depends
 * on: permission checks, finalized-month protection and — most damagingly —
 * `is_manual_override`, which the overwhelming majority of contribution_scores
 * rows carry. A browser-side delete-then-insert silently discarded curated
 * earnings.
 *
 * Guarantees:
 *   • permission-gated (contributions.edit)
 *   • refuses when the task's payroll month is finalized
 *   • preserves manually-overridden scores: they are re-inserted as they were,
 *     never replaced by a freshly computed figure
 *   • replaces the row set for one task only, never a bulk rewrite
 */
export interface SaveContributionsInput {
  taskId: string
  /**
   * parameter_id → employee_id → value. Zero/absent values are dropped.
   * Omit entirely (score-only recalc) to leave the existing contributions and
   * task_tools rows untouched — the bulk auto-recalc path uses this.
   */
  contributions?: Record<string, Record<string, number>>
  /** Computed per-employee outcome. Omit to leave existing scores untouched. */
  scores?: { employeeId: string; scorePercentage: number; earnings: number }[]
  toolIds?: string[]
  /** Move pending/in_progress → done, as the panel does today. */
  markDone?: boolean
}

export async function saveTaskContributions(
  input: SaveContributionsInput,
): Promise<{ ok: boolean; error?: string; preservedOverrides?: number }> {
  const guard = await requireAnyPermission([PERMS.CONTRIBUTIONS_EDIT])
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()

  const { data: task, error: taskErr } = await admin
    .from('tasks')
    .select('id, status, task_date, title')
    .eq('id', input.taskId)
    .maybeSingle()
  if (taskErr) return { ok: false, error: taskErr.message }
  if (!task) return { ok: false, error: 'Task not found.' }

  // Fails closed on an unreadable date — see isTaskMonthProtected.
  if (await isTaskMonthProtected(admin, task.task_date)) {
    return { ok: false, error: 'That month’s payroll is finalized — contributions can no longer be changed.' }
  }

  // Manual overrides are re-inserted verbatim. Recomputing over them is how the
  // curated ledger gets destroyed.
  const { data: existing } = await admin
    .from('contribution_scores')
    .select('employee_id, score_percentage, earnings_inr, is_manual_override')
    .eq('task_id', input.taskId)
  const overrides = (existing ?? []).filter(s => s.is_manual_override)
  const overriddenEmployees = new Set(overrides.map(s => s.employee_id))

  const contribRows = Object.entries(input.contributions ?? {}).flatMap(([parameterId, byEmployee]) =>
    Object.entries(byEmployee)
      .filter(([, value]) => Number(value) > 0)
      .map(([employeeId, value]) => ({
        task_id: input.taskId, employee_id: employeeId,
        parameter_id: parameterId, value: Number(value),
      })),
  )

  // Score-only recalc leaves contributions/tools untouched.
  if (input.contributions !== undefined) {
    const { error: delContrib } = await admin.from('contributions').delete().eq('task_id', input.taskId)
    if (delContrib) return { ok: false, error: delContrib.message }
    const { error: delTools } = await admin.from('task_tools').delete().eq('task_id', input.taskId)
    if (delTools) return { ok: false, error: delTools.message }

    if (contribRows.length) {
      const { error } = await admin.from('contributions').insert(contribRows)
      if (error) return { ok: false, error: error.message }
    }

    if (input.toolIds?.length) {
      const { error } = await admin
        .from('task_tools')
        .insert(input.toolIds.map(toolId => ({ task_id: input.taskId, tool_id: toolId })))
      if (error) return { ok: false, error: error.message }
    }
  }

  if (input.scores) {
    const { error: delScores } = await admin
      .from('contribution_scores').delete().eq('task_id', input.taskId)
    if (delScores) return { ok: false, error: delScores.message }

    const computed = input.scores
      .filter(s => !overriddenEmployees.has(s.employeeId))
      .map(s => ({
        task_id: input.taskId, employee_id: s.employeeId,
        score_percentage: s.scorePercentage, earnings_inr: s.earnings,
        is_manual_override: false,
      }))
    const preserved = overrides.map(s => ({
      task_id: input.taskId, employee_id: s.employee_id,
      score_percentage: s.score_percentage, earnings_inr: s.earnings_inr,
      is_manual_override: true,
    }))

    const rows = [...computed, ...preserved]
    if (rows.length) {
      const { error } = await admin.from('contribution_scores').insert(rows)
      if (error) return { ok: false, error: error.message }
    }

    if (input.markDone && ['pending', 'in_progress'].includes(task.status ?? '')) {
      await admin.from('tasks').update({ status: 'done' }).eq('id', input.taskId)
    }
  }

  void logActivity({
    actorId: guard.employeeId,
    entityType: 'task',
    entityId: input.taskId,
    action: 'contribution_saved',
    detail: {
      title: task.title,
      employees: new Set(contribRows.map(r => r.employee_id)).size,
      preserved_overrides: overrides.length,
    },
  })

  return { ok: true, preservedOverrides: overrides.length }
}

/**
 * Pre-creates empty contribution slots when a parameter-driven sub-task is
 * created: one unassigned row per billable parameter, for employees to claim
 * later. Separate from saveTaskContributions because it runs at task-create
 * time and must not touch scores.
 */
export async function createContributionSlots(
  taskId: string,
  slots: { parameterId: string; value: number }[],
): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireAnyPermission([PERMS.CONTRIBUTIONS_EDIT, PERMS.TASKS_CREATE])
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!slots.length) return { ok: true }

  const admin = createAdminClient()
  const { error } = await admin.from('contributions').insert(
    slots.map(s => ({
      task_id: taskId, parameter_id: s.parameterId,
      employee_id: null, value: s.value, locked: false,
    })),
  )
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
