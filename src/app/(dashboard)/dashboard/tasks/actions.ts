'use server'

/**
 * Task server actions — wraps the key task lifecycle mutations so they
 * are logged to activity_logs as a side-effect.
 *
 * Strategy:
 *  • Simple state changes (delete, restore, status) live entirely here —
 *    the browser client calls the server action instead of Supabase directly.
 *  • Task create is kept browser-side (complex billing math) but calls
 *    logTaskEvent() afterwards for the log row.
 *
 * All functions follow the same shape as other actions in this codebase:
 *   requirePermission → guard → DB mutation → logActivity (void) → return
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/auth/enforce'
import { logActivity } from '@/lib/activity/log'
import { PERMS } from '@/lib/permissions/keys'
import { revalidatePath } from 'next/cache'

const REVALIDATE = '/dashboard/tasks'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

// ── Soft delete (move to Trash) ───────────────────────────────────────────────

export async function serverDeleteTask(
  taskId: string,
  taskTitle: string,
): Promise<ActionResult<{ deleted_at: string }>> {
  const guard = await requirePermission(PERMS.TASKS_DELETE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin   = createAdminClient()
  const deletedAt = new Date().toISOString()

  const { error } = await admin
    .from('tasks')
    .update({ deleted_at: deletedAt })
    .eq('id', taskId)
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   taskId,
    action:     'deleted',
    detail:     { title: taskTitle },
  })

  return { ok: true, data: { deleted_at: deletedAt } }
}

// ── Restore from Trash ────────────────────────────────────────────────────────

export async function serverRestoreTask(
  taskId: string,
  taskTitle: string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.TASKS_TRASH)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('tasks')
    .update({ deleted_at: null })
    .eq('id', taskId)
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   taskId,
    action:     'restored',
    detail:     { title: taskTitle },
  })

  return { ok: true }
}

// ── Permanent delete ──────────────────────────────────────────────────────────

export async function serverPermanentDeleteTask(
  taskId: string,
  taskTitle: string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.TASKS_TRASH)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin.from('tasks').delete().eq('id', taskId)
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   taskId,
    action:     'deleted',
    detail:     { title: taskTitle, permanent: true },
  })

  return { ok: true }
}

// ── Status change ─────────────────────────────────────────────────────────────

export async function serverUpdateTaskStatus(
  taskId: string,
  taskTitle: string,
  fromStatus: string,
  toStatus:   string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.TASKS_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('tasks')
    .update({ status: toStatus })
    .eq('id', taskId)
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   taskId,
    action:     'status_changed',
    detail:     { title: taskTitle, from: fromStatus, to: toStatus },
  })

  return { ok: true }
}

// ── Bulk status change ────────────────────────────────────────────────────────

export async function serverBulkUpdateStatus(
  ids:      string[],
  toStatus: string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.TASKS_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  if (!ids.length) return { ok: false, error: 'No tasks selected.' }

  const admin = createAdminClient()
  // Batch in chunks of 100 to stay under Supabase IN() limit
  const CHUNK = 100
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const { error } = await admin
      .from('tasks')
      .update({ status: toStatus })
      .in('id', chunk)
    if (error) return { ok: false, error: error.message }
  }

  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   null,
    action:     'status_changed',
    detail:     { bulk: true, count: ids.length, to: toStatus },
  })

  return { ok: true }
}

// ── Cancel task ───────────────────────────────────────────────────────────────

export interface CancelTaskInput {
  taskId:              string
  taskTitle:           string
  cancelledBy:         string
  notes:               string | null
  honorContributions:  boolean
  lossAmount:          number
  completionPct:       number
  recordCashbook:      boolean
  taskDate:            string
  clientName:          string | null
}

export async function serverCancelTask(
  input: CancelTaskInput,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.TASKS_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()

  // 1. Update task
  const { error: taskErr } = await admin.from('tasks').update({
    status:               'cancelled',
    cancelled_by:         input.cancelledBy,
    cancellation_notes:   input.notes || null,
    honor_contributions:  input.honorContributions,
    loss_amount:          input.lossAmount,
    completion_pct:       input.completionPct,
  }).eq('id', input.taskId)
  if (taskErr) return { ok: false, error: taskErr.message }

  // 2. Remove contribution scores if not honouring
  if (!input.honorContributions) {
    await admin.from('contribution_scores').delete().eq('task_id', input.taskId)
  }

  // 3. Optionally record cashbook loss
  if (input.recordCashbook && input.lossAmount > 0) {
    const who = input.cancelledBy === 'client' ? 'Client cancellation'
      : input.cancelledBy === 'no_show' ? 'No-show' : 'Company decision'
    const desc = `[JOB LOSS] ${input.taskTitle}`
      + (input.clientName ? ` — ${input.clientName}` : '')
      + ` (${input.completionPct}% done, ${who})`
      + (input.notes ? ` — ${input.notes}` : '')
    await admin.from('cashbook_entries').insert({
      type:        'outflow',
      amount_inr:  input.lossAmount,
      entry_date:  input.taskDate,
      description: desc,
    })
  }

  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   input.taskId,
    action:     'status_changed',
    detail:     {
      title:         input.taskTitle,
      from:          'active',
      to:            'cancelled',
      cancelled_by:  input.cancelledBy,
      loss_amount:   input.lossAmount,
    },
  })

  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ── Log task created (called from browser after insert) ───────────────────────
// Task create has complex billing math done browser-side, so the DB insert
// stays there. This lightweight action just writes the log row.

export async function logTaskCreated(
  taskId:    string,
  taskTitle: string,
  taskNumber: number | null,
): Promise<void> {
  const guard = await requirePermission(PERMS.TASKS_CREATE)
  if (!guard.ok) return

  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   taskId,
    action:     'created',
    detail:     { title: taskTitle, task_number: taskNumber },
  })
}
