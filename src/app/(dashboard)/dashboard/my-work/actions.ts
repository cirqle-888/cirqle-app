'use server'

/**
 * My Work — server actions for a designer's own queue.
 *
 * Permission model: requests.work_own, plus a per-row assignment check that
 * the permission alone cannot express. The key says "may work an assigned
 * queue"; the check says "…and this row is yours". Both are required on every
 * mutation — holding the key is never sufficient to touch a row you were not
 * assigned.
 *
 * Deliberately NOT reusing setRequestStatusAction: its STATUS_PERM map gates
 * in_progress / delivered / completed behind requests.manage, which also
 * unlocks the whole inbox. This module is the narrow door.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { syncRequestStatusFromTask } from '@/lib/requests/task-sync'
import { serverFillTaskBilling } from '@/app/(dashboard)/dashboard/tasks/actions'
import { nextTaskNumber } from '@/lib/utils/task-code'
import { todayISO } from '@/lib/utils/local-date'
import {
  stageOf, canMove, isHidden, STAGE_TARGET_STATUS, STAGE_LABEL,
  moveRefusalReason, type WorkStage,
} from '@/lib/requests/my-work'

const REVALIDATE = '/dashboard/my-work'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

export interface MyWorkRow {
  id: string
  ref_no: number | null
  title: string
  description: string | null
  status: string
  due_date: string | null
  priority: string | null
  created_at: string
  client_name: string | null
  service_name: string | null
  task_number: number | null
}

/**
 * The caller's own assigned queue. Never takes an employee id — it is always
 * the signed-in user, so there is no parameter to tamper with.
 */
export async function fetchMyWork(): Promise<ActionResult<MyWorkRow[]>> {
  const guard = await requirePermission(PERMS.REQUESTS_WORK_OWN)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('task_requests')
    .select('id, ref_no, title, description, status, due_date, priority, created_at, ' +
      'client:clients(name), service:services(name), ' +
      'promoted_task:tasks!task_requests_promoted_task_id_fkey(task_number)')
    .eq('assigned_employee_id', guard.employeeId)
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
  if (error) return { ok: false, error: error.message }

  const rows: MyWorkRow[] = (data || [])
    .filter((r: any) => !isHidden(r.status))
    .map((r: any) => {
      const c = Array.isArray(r.client) ? r.client[0] : r.client
      const s = Array.isArray(r.service) ? r.service[0] : r.service
      const t = Array.isArray(r.promoted_task) ? r.promoted_task[0] : r.promoted_task
      return {
        id: r.id, ref_no: r.ref_no, title: r.title, description: r.description,
        status: r.status, due_date: r.due_date, priority: r.priority,
        created_at: r.created_at,
        client_name: c?.name ?? null,
        service_name: s?.name ?? null,
        task_number: t?.task_number ?? null,
      }
    })
  return { ok: true, data: rows }
}

/** Task status that backs each stage. Round-trips through
 *  requestStatusFromTask() to exactly the stage it came from:
 *    in_progress → request in_progress → 'working'
 *    delivered   → request delivered   → 'delivered'
 *    done        → request completed   → 'done'
 *  so driving the task can never leave the board showing a different column
 *  from the one the card was dropped in. */
const STAGE_TASK_STATUS: Partial<Record<WorkStage, string>> = {
  working: 'in_progress',
  delivered: 'delivered',
  done: 'done',
}

/**
 * Find or create the task behind a request, and return its id.
 *
 * The designer never sees or chooses a price: the task is inserted at zero and
 * serverFillTaskBilling then reads the client/service pricing matrix
 * server-side, which is the same path the Add Task form uses for anyone who
 * cannot see pricing. A wrong number is worse than a late one, so the amount is
 * never guessed here.
 */
async function ensureTaskForRequest(
  admin: ReturnType<typeof createAdminClient>,
  req: any,
  employeeId: string,
): Promise<{ taskId: string; created: boolean; warning?: string }> {
  if (req.promoted_task_id) return { taskId: req.promoted_task_id, created: false }

  const maxRow = await admin.from('tasks')
    .select('task_number').order('task_number', { ascending: false, nullsFirst: false })
    .limit(1).maybeSingle()

  const payload: Record<string, unknown> = {
    task_number: nextTaskNumber(maxRow.data?.task_number),
    title: req.title,
    description: req.description ?? null,
    client_id: req.client_id ?? null,
    service_id: req.service_id ?? null,
    task_date: req.due_date || todayISO(),
    status: 'in_progress',
    quantity: 1,
    billing_amount: 0,
    billing_amount_inr: 0,
  }
  const { data: task, error } = await admin.from('tasks').insert(payload).select('id').single()
  if (error || !task) throw new Error(error?.message || 'Could not create the task.')

  // Link it the same way the inbox does, so the request is "promoted" by every
  // reader (including task-sync, which only looks at promoted_task_id).
  await admin.from('task_requests')
    .update({ promoted_task_id: task.id, updated_at: new Date().toISOString() })
    .eq('id', req.id)

  // Price it. Fire-and-forget would be wrong here — a task stuck at zero is a
  // silently unbilled job — but a pricing failure must not undo real work
  // either, so it is reported as a warning instead of an error.
  let warning: string | undefined
  try {
    await serverFillTaskBilling(task.id, req.client_id ?? null, req.service_id ?? null, 1)
  } catch {
    warning = 'The task was created but could not be priced automatically — a manager should set its amount.'
  }

  void logActivity({
    actorId: employeeId, entityType: 'task', entityId: task.id,
    action: 'created', category: 'crm', clientId: req.client_id ?? null,
    detail: { label: 'Auto-created from My Work', requestId: req.id, refNo: req.ref_no },
  })

  return { taskId: task.id, created: true, warning }
}

/**
 * Move one of the caller's own requests to a new stage.
 *
 * Gates, in order — each load-bearing:
 *   1. holds requests.work_own
 *   2. the row is assigned to THEM (the permission cannot express this)
 *   3. the stage transition is legal (forward, or Delivered → Working)
 *
 * THE TASK IS THE SOURCE OF TRUTH, NOT THE REQUEST. Once a request carries a
 * promoted_task_id, syncRequestStatusFromTask mirrors the task's status onto
 * it (and emails the requester on delivered/completed). Writing the request
 * status directly as well would mean two writers for one fact, and the sync
 * would overwrite whatever this action set the moment the task next changed.
 * So every forward move ensures a task exists and then moves the TASK; the
 * request — and the client's portal — follow from the sync.
 *
 * That also delivers the auto-task behaviour: starting work IS what creates the
 * task, rather than a manager having to promote it from the inbox first.
 */
export async function moveMyWork(
  requestId: string, toStage: WorkStage,
): Promise<ActionResult<{ status: string; taskCreated?: boolean; warning?: string }>> {
  const guard = await requirePermission(PERMS.REQUESTS_WORK_OWN)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: req, error } = await admin
    .from('task_requests')
    .select('id, ref_no, title, description, status, assigned_employee_id, promoted_task_id, client_id, service_id, due_date')
    .eq('id', requestId).maybeSingle()
  if (error || !req) return { ok: false, error: 'That work item could not be found.' }

  // The check the permission cannot make. Admins are NOT exempt here: an admin
  // moving someone else's card should do it from the inbox, where the action is
  // logged as an inbox change rather than as the assignee's own progress.
  if ((req as any).assigned_employee_id !== guard.employeeId) {
    return { ok: false, error: 'This work is assigned to someone else.' }
  }

  const from = stageOf((req as any).status)
  if (from === toStage) return { ok: true, data: { status: (req as any).status } }
  if (!canMove(from, toStage)) {
    return { ok: false, error: moveRefusalReason(from, toStage) }
  }

  const taskStatus = STAGE_TASK_STATUS[toStage]
  if (!taskStatus) return { ok: false, error: moveRefusalReason(from, toStage) }

  let taskId: string
  let created = false
  let warning: string | undefined
  try {
    const r = await ensureTaskForRequest(admin, req, guard.employeeId)
    taskId = r.taskId; created = r.created; warning = r.warning
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not create the task for this work.' }
  }

  const { error: taskErr } = await admin.from('tasks')
    .update({ status: taskStatus, updated_at: new Date().toISOString() })
    .eq('id', taskId)
  if (taskErr) return { ok: false, error: 'Could not update the task status. Try again.' }

  // Mirror onto the request. This is what writes client_status, the portal
  // timeline entry and the milestone email — so there is deliberately no
  // separate notifyRequesterStatus call here; adding one would email twice.
  await syncRequestStatusFromTask(taskId, taskStatus)

  const target = STAGE_TARGET_STATUS[toStage]!

  void logActivity({
    actorId: guard.employeeId, entityType: 'task', entityId: taskId,
    action: 'updated', category: 'crm', clientId: (req as any).client_id ?? null,
    note: `My Work: ${(req as any).ref_no ? `REQ-${String((req as any).ref_no).padStart(4, '0')}` : 'request'} → ${STAGE_LABEL[toStage]}`,
    detail: { requestId, from, to: toStage, taskStatus, taskCreated: created },
  })

  revalidatePath(REVALIDATE); revalidatePath('/dashboard/requests'); revalidatePath('/dashboard/tasks')
  return { ok: true, data: { status: target, taskCreated: created, warning } }
}
