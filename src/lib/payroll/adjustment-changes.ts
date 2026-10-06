/**
 * Which tasks moved a prior-period adjustment — read from the audit trail.
 *
 * A correction to a closed month usually has a simple cause: someone edited a
 * paid month's contributions (gave a share to a second person, re-scored a
 * task). `saveTaskContributions` writes an audit entry for every such save,
 * holding each person's before and after. This reads those entries back and
 * nets them per task, so the payroll screen can say "#1902: ₹800 → ₹640" instead
 * of just "−₹291".
 *
 * It explains CONTRIBUTION edits only. A task removed, or re-priced by a
 * billing change, leaves no such entry — that is what `removedTasks` and the
 * "unexplained" remainder on the adjustment already cover, and the two add up.
 *
 * ADMIN EYES ONLY. The detail names who edited whose share. Employees never
 * receive it: their payslip reads only month and amount of an adjustment, and
 * `forViewer` strips these lines from any record belonging to the viewer.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface AdjustmentChange {
  taskId: string
  taskNumber: number | null
  title: string | null
  taskDate: string | null
  /** The employee's earnings on this task when that month was paid. */
  fromInr: number
  /** …and today. */
  toInr: number
  /** The person who made the last edit, and when (ISO). */
  changedByCqid: string | null
  changedAt: string
}

export interface AuditEntry {
  entity_id: string
  actor_id: string | null
  created_at: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  detail: any
}

export interface NetChange {
  taskId: string
  fromInr: number
  toInr: number
  actorId: string | null
  changedAt: string
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * Net each task's edits for one employee and month: the FIRST entry's "from"
 * to the LAST entry's "to", so a share set to 50% and then to 80% reads as one
 * change, not two. Entries that never touched this employee are ignored;
 * tasks that net to no change are dropped. `sinceISO` ignores edits made
 * before the month was paid — they are part of what was paid, not a change.
 */
export function netChangesFromAudit(
  entries: AuditEntry[], employeeId: string, month: number, year: number, sinceISO?: string,
): NetChange[] {
  const byTask = new Map<string, NetChange>()
  const ordered = [...entries].sort((a, b) => a.created_at.localeCompare(b.created_at))
  for (const e of ordered) {
    if (Number(e.detail?.month) !== month || Number(e.detail?.year) !== year) continue
    if (sinceISO && e.created_at < sinceISO) continue
    const row = (e.detail?.scores as { employee_id: string; from: { earnings_inr?: number | null } | null; to: { earnings_inr?: number | null } | null }[] | undefined)
      ?.find(s => s.employee_id === employeeId)
    if (!row) continue
    const cur = byTask.get(e.entity_id)
    byTask.set(e.entity_id, {
      taskId: e.entity_id,
      fromInr: cur ? cur.fromInr : Number(row.from?.earnings_inr ?? 0),
      toInr: Number(row.to?.earnings_inr ?? 0),
      actorId: e.actor_id,
      changedAt: e.created_at,
    })
  }
  return [...byTask.values()].filter(c => Math.abs(c.toInr - c.fromInr) >= 0.005)
}

/** How much of an adjustment these changes account for (negative = employee earns less now). */
export function netEffect(changes: Pick<AdjustmentChange, 'fromInr' | 'toInr'>[]): number {
  return r2(changes.reduce((sum, c) => sum + (c.toInr - c.fromInr), 0))
}

/** Read the audit trail and label the tasks and people in it. Best-effort: [] on any failure. */
export async function loadAdjustmentChanges(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  employeeId: string, month: number, year: number, sinceISO?: string,
): Promise<AdjustmentChange[]> {
  try {
    let q = admin.from('activity_logs')
      .select('entity_id, actor_id, created_at, detail')
      .eq('action', 'contribution_corrected_closed_period')
      .order('created_at', { ascending: true })
      .limit(2000)
    if (sinceISO) q = q.gte('created_at', sinceISO)
    const { data } = await q
    const nets = netChangesFromAudit((data ?? []) as AuditEntry[], employeeId, month, year, sinceISO)
    if (!nets.length) return []

    const [{ data: tasks }, { data: people }] = await Promise.all([
      admin.from('tasks').select('id, task_number, title, task_date').in('id', nets.map(n => n.taskId)),
      admin.from('employees').select('id, cqid').in('id', [...new Set(nets.map(n => n.actorId).filter(Boolean) as string[])]),
    ])
    const T = new Map((tasks ?? []).map((t: { id: string }) => [t.id, t as { id: string; task_number: number | null; title: string | null; task_date: string | null }]))
    const P = new Map((people ?? []).map((p: { id: string; cqid: string }) => [p.id, p.cqid]))
    return nets
      .map(n => ({
        taskId: n.taskId,
        taskNumber: T.get(n.taskId)?.task_number ?? null,
        title: T.get(n.taskId)?.title ?? null,
        taskDate: T.get(n.taskId)?.task_date ?? null,
        fromInr: r2(n.fromInr), toInr: r2(n.toInr),
        changedByCqid: n.actorId ? P.get(n.actorId) ?? null : null,
        changedAt: n.changedAt,
      }))
      .sort((a, b) => (a.taskNumber ?? 0) - (b.taskNumber ?? 0))
  } catch (e) {
    console.error('[adjustment-changes] load failed:', e instanceof Error ? e.message : e)
    return []
  }
}

/**
 * What a viewer may see of an adjustment's task-level changes. The employee a
 * correction is about never sees them, admin or not (an admin viewing their
 * own record is the one exception: they run payroll).
 */
export function forViewer<T>(changes: T[], opts: { viewerEmployeeId: string | null; subjectEmployeeId: string; viewerIsAdmin: boolean }): T[] {
  if (opts.viewerIsAdmin) return changes
  return opts.viewerEmployeeId && opts.viewerEmployeeId === opts.subjectEmployeeId ? [] : changes
}
