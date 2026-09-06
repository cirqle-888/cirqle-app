/**
 * Prior-period adjustment ledger — closed books are never reopened.
 *
 * THE WORKFLOW THIS SUPPORTS: a task is remembered late and created with its
 * ORIGINAL date, landing in a month whose payroll is already paid. Standard
 * accounting says you do not reopen a closed period; you post the correction
 * to the current open one. That is exactly what happens here:
 *
 *   1. detectAdjustments() compares, per employee, what a CLOSED month's
 *      contribution earnings are NOW against what that month's payroll
 *      actually PAID. Any difference is recorded as an adjustment with full
 *      lineage (which month, how much, why).
 *   2. settleAdjustments() attaches the open adjustments to the current open
 *      payroll, where they appear as a visible "Prior-period adjustment" line
 *      and are paid alongside that month's salary.
 *
 * The source month's payroll, profit snapshot and reports never change.
 * Analytical views (Contribution Analysis) still show the work in its true
 * month — that is correct: reports show when work happened, payroll shows when
 * money moved, and this ledger is the auditable bridge between the two.
 *
 * THE CONTRIBUTION ENGINE IS NOT TOUCHED. This module only READS
 * contribution_scores; it never recomputes, rewrites or reweights them.
 *
 * Deltas are SIGNED. A late task produces a positive adjustment (owed to the
 * employee); a deleted or re-priced task can produce a negative one (overpaid).
 * Both are shown explicitly rather than silently dropped — hiding an overpayment
 * would make payroll disagree with the ledger.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { isMonthFinalized } from './compute'
import { monthBounds } from '@/lib/finance/profit'

// Canonical money rounding — a local Math.round(n * 100) / 100 disagrees at
// the .xx5 midpoints (1.005 -> 1.00 instead of 1.01). See currency.ts round2.
import { round2 as r2 } from '@/lib/calculations/currency'

/** Ignore sub-rupee drift — rounding noise is not an adjustment. */
const MATERIALITY_INR = 1

/** One task standing behind an adjustment, for the "why" trail. */
export interface AdjustmentTaskLine {
  taskId: string
  taskNumber: number | null
  title: string | null
  taskDate: string | null
  earningsInr: number
  /** Set when the task has been soft-deleted since the month was paid. */
  deletedAt?: string | null
}

/**
 * What an adjustment is made of, captured AT DETECTION TIME.
 *
 * It has to be captured here because it is not reconstructable later: a task
 * that is permanently deleted takes its contribution score with it, and then
 * nothing in the database can say what the difference was for.
 */
export interface AdjustmentLineage {
  /** The tasks that make up the month's earnings TODAY. */
  tasks: AdjustmentTaskLine[]
  /**
   * Tasks from that month, still scored for this employee, that have been
   * soft-deleted since. On a negative adjustment these are usually the cause.
   */
  removedTasks: AdjustmentTaskLine[]
  /**
   * The part of the delta that removed tasks do NOT explain — a permanently
   * deleted task, a re-priced one, or a re-scored contribution. Named rather
   * than hidden so an unexplained figure is visibly unexplained.
   */
  unexplainedInr: number
}

export interface DetectedAdjustment {
  employeeId: string
  sourceMonth: number
  sourceYear: number
  amountInr: number
  currentEarningsInr: number
  paidCommissionInr: number
  lineage?: AdjustmentLineage
}

/**
 * The comparison itself, kept pure so it can be tested without a database.
 *
 * `paid` is what the closed month's payslips actually paid; `current` is what
 * the contribution engine says those employees earned in that month today.
 *
 * Only employees who were PAID for the month are adjusted. Someone whose first
 * earnings in that month appeared after it closed has no paid baseline to
 * correct — there is nothing to reconcile against, and inventing a correction
 * for them would pay from a period that never accounted for them.
 */
export function computeDeltas(
  paid: Map<string, number>,
  current: Map<string, number>,
  sourceMonth: number,
  sourceYear: number,
  /** employeeId → the tasks behind today's figure. Optional: callers that only
   *  need the amount (and every existing test) can leave it out. */
  liveTasks?: Map<string, AdjustmentTaskLine[]>,
  /** employeeId → that month's tasks this employee is still scored on, since
   *  soft-deleted. The usual explanation for a negative delta. */
  removedTasks?: Map<string, AdjustmentTaskLine[]>,
): DetectedAdjustment[] {
  const out: DetectedAdjustment[] = []
  for (const [employeeId, paidInr] of paid) {
    const currentInr = r2(current.get(employeeId) || 0)
    const delta = r2(currentInr - paidInr)
    if (Math.abs(delta) < MATERIALITY_INR) continue

    let lineage: AdjustmentLineage | undefined
    if (liveTasks || removedTasks) {
      const removed = removedTasks?.get(employeeId) ?? []
      // A removed task used to pay the employee, so it explains a NEGATIVE
      // delta of its own size. Whatever is left over is something else.
      const explained = r2(removed.reduce((sum, t) => sum + t.earningsInr, 0))
      lineage = {
        tasks: liveTasks?.get(employeeId) ?? [],
        removedTasks: removed,
        unexplainedInr: r2(delta + explained),
      }
    }

    out.push({
      employeeId,
      sourceMonth,
      sourceYear,
      amountInr: delta,
      currentEarningsInr: currentInr,
      paidCommissionInr: paidInr,
      lineage,
    })
  }
  return out
}

/**
 * Contribution earnings a closed month would produce today, per employee,
 * against what its payroll actually paid.
 *
 * Read-only: no writes, so no finalized-month guard is needed here. The guard
 * lives on the writers below.
 */
export async function detectAdjustments(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  month: number,
  year: number,
): Promise<DetectedAdjustment[]> {
  const { start, nextStart } = monthBounds(month, year)

  // What the month's payroll paid (only finalized rows represent real money).
  const { data: payrollRows } = await admin
    .from('payroll')
    .select('employee_id, commission_earned, status')
    .eq('month', month)
    .eq('year', year)
  const paid = new Map<string, number>()
  for (const p of (payrollRows || []) as { employee_id: string; commission_earned: number | null; status: string }[]) {
    if (p.status !== 'paid') continue
    paid.set(p.employee_id, Number(p.commission_earned || 0))
  }
  // Nothing was ever paid for this month — there is no baseline to adjust
  // against, so the month is simply still open in payroll terms.
  if (paid.size === 0) return []

  // Every task in the month, live AND soft-deleted. The deleted ones are not
  // counted, but they are the usual explanation for a negative delta, and the
  // trail has to be captured now — a task that is later PERMANENTLY deleted
  // takes its contribution score with it and becomes unrecoverable.
  const { data: tasks } = await admin
    .from('tasks')
    .select('id, task_number, title, task_date, deleted_at')
    .gte('task_date', start)
    .lt('task_date', nextStart)
  const taskRows = (tasks || []) as {
    id: string; task_number: number | null; title: string | null
    task_date: string | null; deleted_at: string | null
  }[]
  const taskById = new Map(taskRows.map(t => [t.id, t]))

  const current = new Map<string, number>()
  const liveTasks = new Map<string, AdjustmentTaskLine[]>()
  const removedTasks = new Map<string, AdjustmentTaskLine[]>()

  const push = (
    map: Map<string, AdjustmentTaskLine[]>, employeeId: string, line: AdjustmentTaskLine,
  ) => {
    const list = map.get(employeeId)
    if (list) list.push(line)
    else map.set(employeeId, [line])
  }

  const allIds = taskRows.map(t => t.id)
  const CHUNK = 200
  for (let i = 0; i < allIds.length; i += CHUNK) {
    const { data: scores } = await admin
      .from('contribution_scores')
      .select('task_id, employee_id, earnings_inr')
      .in('task_id', allIds.slice(i, i + CHUNK))
    for (const s of (scores || []) as {
      task_id: string; employee_id: string; earnings_inr: number | null
    }[]) {
      const task = taskById.get(s.task_id)
      if (!task) continue
      const earningsInr = Number(s.earnings_inr || 0)
      const line: AdjustmentTaskLine = {
        taskId: task.id,
        taskNumber: task.task_number,
        title: task.title,
        taskDate: task.task_date,
        earningsInr: r2(earningsInr),
      }
      if (task.deleted_at) {
        // Deliberately NOT added to `current` — the money total must keep
        // matching what the payroll engine itself counts, which is live tasks
        // only. This list exists to EXPLAIN the difference, not to change it.
        push(removedTasks, s.employee_id, { ...line, deletedAt: task.deleted_at })
      } else {
        current.set(s.employee_id, (current.get(s.employee_id) || 0) + earningsInr)
        push(liveTasks, s.employee_id, line)
      }
    }
  }

  const byDateDesc = (a: AdjustmentTaskLine, b: AdjustmentTaskLine) =>
    (b.taskDate || '').localeCompare(a.taskDate || '')
  for (const list of liveTasks.values()) list.sort(byDateDesc)
  for (const list of removedTasks.values()) list.sort(byDateDesc)

  return computeDeltas(paid, current, month, year, liveTasks, removedTasks)
}

/**
 * Record detected deltas for a closed month.
 *
 * HISTORICAL EARNINGS PROTECTION: this writes nothing unless the source month
 * really is closed. An open month needs no adjustment ledger — recalculating
 * its payroll picks the change up directly, and writing an adjustment as well
 * would pay the same rupees twice.
 *
 * Upserts on (employee, source month, reason) so re-running only refreshes the
 * amount instead of stacking duplicates. Already-settled rows are left alone:
 * once money has moved, the record is history.
 */
export async function recordAdjustments(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  month: number,
  year: number,
): Promise<{ recorded: number; skipped?: 'open' }> {
  if (!(await isMonthFinalized(admin, month, year))) {
    return { recorded: 0, skipped: 'open' }
  }

  const detected = await detectAdjustments(admin, month, year)
  if (detected.length === 0) return { recorded: 0 }

  const { data: settled } = await admin
    .from('payroll_adjustments')
    .select('employee_id')
    .eq('source_month', month)
    .eq('source_year', year)
    .not('settled_at', 'is', null)
  const settledEmployees = new Set(
    (settled || []).map((r: { employee_id: string }) => r.employee_id),
  )

  const rows = detected
    .filter(d => !settledEmployees.has(d.employeeId))
    .map(d => ({
      employee_id: d.employeeId,
      source_month: d.sourceMonth,
      source_year: d.sourceYear,
      amount_inr: d.amountInr,
      reason: 'contribution_delta',
      breakdown: {
        currentEarningsInr: d.currentEarningsInr,
        paidCommissionInr: d.paidCommissionInr,
        note: 'Contribution earnings for a closed month changed after payroll was paid (typically a task entered later with its original date).',
        // The WHY, captured now because it cannot be reconstructed later.
        ...(d.lineage ? {
          tasks: d.lineage.tasks,
          removedTasks: d.lineage.removedTasks,
          unexplainedInr: d.lineage.unexplainedInr,
        } : {}),
      },
      detected_at: new Date().toISOString(),
    }))
  if (rows.length === 0) return { recorded: 0 }

  const { error } = await admin
    .from('payroll_adjustments')
    .upsert(rows, { onConflict: 'employee_id,source_month,source_year,reason' })
  return { recorded: error ? 0 : rows.length }
}

export interface PendingAdjustment {
  id: string
  employeeId: string
  sourceMonth: number
  sourceYear: number
  amountInr: number
  reason: string
}

/** Unsettled adjustments, for the payroll draft and the month view. */
export async function loadPendingAdjustments(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
): Promise<PendingAdjustment[]> {
  try {
    const { data, error } = await admin
      .from('payroll_adjustments')
      .select('id, employee_id, source_month, source_year, amount_inr, reason')
      .is('settled_at', null)
      .order('source_year')
      .order('source_month')
    if (error) return []
    return (data || []).map((r: Record<string, unknown>) => ({
      id: r.id as string,
      employeeId: r.employee_id as string,
      sourceMonth: Number(r.source_month),
      sourceYear: Number(r.source_year),
      amountInr: Number(r.amount_inr || 0),
      reason: String(r.reason || ''),
    }))
  } catch {
    return [] // pre-migration — no adjustments exist
  }
}

/** Pending totals per employee, for the payroll net calculation. */
export async function pendingAdjustmentTotals(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const a of await loadPendingAdjustments(admin)) {
    out[a.employeeId] = r2((out[a.employeeId] || 0) + a.amountInr)
  }
  return out
}

/**
 * Mark adjustments settled into the month that just paid them.
 *
 * NO finalized-month guard here, deliberately: this is called from
 * markPayrollPaid for the month being paid, at which point that month is
 * finalized BY DEFINITION. Guarding on `isMonthFinalized` would block the one
 * call that is supposed to happen. Protection comes from the other side
 * instead — a row is stamped once and `.is('settled_at', null)` never selects
 * it again, so settled history is immutable.
 *
 * This writes no earnings; it only records which payroll discharged an
 * existing ledger row.
 */
export async function settleAdjustments(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  employeeId: string,
  month: number,
  year: number,
): Promise<{ settled: number }> {
  const { data: pending } = await admin
    .from('payroll_adjustments')
    .select('id')
    .eq('employee_id', employeeId)
    .is('settled_at', null)
  const ids = (pending || []).map((r: { id: string }) => r.id)
  if (ids.length === 0) return { settled: 0 }

  const { error } = await admin
    .from('payroll_adjustments')
    .update({ settled_month: month, settled_year: year, settled_at: new Date().toISOString() })
    .in('id', ids)
  return { settled: error ? 0 : ids.length }
}
