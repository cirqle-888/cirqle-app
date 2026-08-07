'use server'

import { syncTaskAgreementEarnings } from '@/lib/sync/agreement-earnings'
import { requireAnyPermission } from '@/lib/permissions/check'
import { createAdminClient } from '@/lib/supabase/admin'
import { PERMS } from '@/lib/permissions/keys'
import { isTaskMonthProtected } from '@/lib/payroll/compute'
import { recordAdjustments } from '@/lib/payroll/adjustments'
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
  /** Optional free-text reason, recorded on the closed-period audit entry. */
  reason?: string
}

export interface SaveContributionsResult {
  ok: boolean
  error?: string
  preservedOverrides?: number
  /** True when the task's month is closed and this ran as a prior-period correction. */
  closedPeriod?: boolean
  /** Closed period only: `payroll_adjustments` rows queued for the next open payroll. */
  adjustmentsRecorded?: number
  /** Closed period only: the month that was corrected, for the UI message. */
  correctedMonth?: string
}

export async function saveTaskContributions(
  input: SaveContributionsInput,
): Promise<SaveContributionsResult> {
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

  // ── Closed period? A correction, not a refusal ────────────────────────────
  //
  // Standard practice: closed books are never reopened, but the WORK RECORD is
  // not the books. A task remembered late belongs in the month it happened, so
  // this writes the contribution data and lets the existing prior-period
  // adjustment engine carry the money difference into the next OPEN payroll.
  //
  // What a closed-period save may touch: contributions, contribution_scores,
  // task_tools. Nothing else. Historical payslips, cash book entries, profit
  // snapshots and reports are all left exactly as they were — see the
  // markDone and payroll-recalc notes below for the two places that would
  // otherwise leak into them.
  //
  // `isTaskMonthProtected` fails closed on an unreadable date. That now means
  // "treat as a correction", which is the safe direction: the write is confined
  // to work data either way, and refusing on a malformed date would block a
  // legitimate edit with no way to fix it.
  const closedPeriod = await isTaskMonthProtected(admin, task.task_date)
  const [taskYear, taskMonth] = String(task.task_date ?? '').split('-').map(Number)
  const monthLabel = (() => {
    const d = new Date(`${task.task_date}T00:00:00`)
    return Number.isNaN(d.getTime())
      ? 'that month'
      : d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
  })()

  // Before-state for the audit trail. Only read for a closed period — on the
  // open-month path this is pure overhead, and that is the hot path.
  const before = closedPeriod ? await readCorrectionState(admin, input.taskId) : null

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

    // NOT in a closed period. Task status is an input to revenue reporting, so
    // flipping a historical task to done as a side effect of a correction would
    // move that month's reported revenue — the one thing a prior-period
    // correction must never do. The correction records the work; it does not
    // re-run the month's workflow.
    if (input.markDone && !closedPeriod && ['pending', 'in_progress'].includes(task.status ?? '')) {
      await admin.from('tasks').update({ status: 'done' }).eq('id', input.taskId)
    }
  }

  // ── Closed period: audit, then queue the money difference ─────────────────
  if (closedPeriod) {
    const after = await readCorrectionState(admin, input.taskId)

    // AWAITED, not fire-and-forget. An edit to closed books that is not on the
    // record is exactly the thing an audit must never permit, so the entry is
    // written before the caller is told the correction succeeded.
    await logActivity({
      actorId: guard.employeeId,
      entityType: 'task',
      entityId: input.taskId,
      taskId: input.taskId,
      action: 'contribution_corrected_closed_period',
      note: input.reason ?? null,
      detail: {
        title: task.title,
        month: taskMonth, year: taskYear, month_label: monthLabel,
        reason: input.reason ?? null,
        preserved_overrides: overrides.length,
        // Full before/after, per employee — what the money difference is
        // computed from, and the only record of what the figures used to be.
        scores: diffScores(before?.scores ?? [], after.scores),
        contribution_rows: { from: before?.contributions ?? 0, to: after.contributions },
        tool_rows: { from: before?.tools ?? 0, to: after.tools },
      },
    })

    // Reuse the existing engine — no new adjustment model. It compares what the
    // month's contribution earnings are worth NOW against what its payroll
    // actually PAID, and records the delta against the next open payroll.
    // Returns 0 when nobody was paid for that month yet (an explicit lock with
    // pending payslips): there is no paid baseline to correct, and that month's
    // own payroll will pick the new figures up when it is prepared.
    let adjustmentsRecorded = 0
    if (Number.isInteger(taskMonth) && Number.isInteger(taskYear)) {
      try {
        const res = await recordAdjustments(admin, taskMonth, taskYear)
        adjustmentsRecorded = res.recorded
      } catch {
        // The correction itself is saved and audited; a failed scan is
        // recoverable by clicking Check corrections on the month card.
        adjustmentsRecorded = 0
      }
    }

    return {
      ok: true,
      preservedOverrides: overrides.length,
      closedPeriod: true,
      adjustmentsRecorded,
      correctedMonth: monthLabel,
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

// ── Closed-period audit helpers ──────────────────────────────────────────────

interface CorrectionState {
  scores: { employee_id: string; score_percentage: number | null; earnings_inr: number | null }[]
  contributions: number
  tools: number
}

/** Snapshot of the three tables a correction may touch, for the audit diff. */
async function readCorrectionState(
  admin: ReturnType<typeof createAdminClient>,
  taskId: string,
): Promise<CorrectionState> {
  const [scores, contribs, tools] = await Promise.all([
    admin.from('contribution_scores')
      .select('employee_id, score_percentage, earnings_inr').eq('task_id', taskId),
    admin.from('contributions').select('id').eq('task_id', taskId),
    admin.from('task_tools').select('tool_id').eq('task_id', taskId),
  ])
  return {
    scores: (scores.data ?? []) as CorrectionState['scores'],
    contributions: (contribs.data ?? []).length,
    tools: (tools.data ?? []).length,
  }
}

/**
 * Per-employee before/after, including employees who appear on only one side —
 * a contributor removed by the correction is precisely what an auditor needs to
 * see, and keying off the "after" rows alone would hide them.
 */
function diffScores(before: CorrectionState['scores'], after: CorrectionState['scores']) {
  const key = (s: { employee_id: string }) => s.employee_id
  const b = new Map(before.map(s => [key(s), s]))
  const a = new Map(after.map(s => [key(s), s]))
  const out: Record<string, unknown>[] = []
  for (const id of new Set([...b.keys(), ...a.keys()])) {
    const from = b.get(id), to = a.get(id)
    const same = (from?.score_percentage ?? null) === (to?.score_percentage ?? null)
      && (from?.earnings_inr ?? null) === (to?.earnings_inr ?? null)
    if (same) continue
    out.push({
      employee_id: id,
      from: from ? { score_percentage: from.score_percentage, earnings_inr: from.earnings_inr } : null,
      to:   to   ? { score_percentage: to.score_percentage,   earnings_inr: to.earnings_inr }   : null,
    })
  }
  return out
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
