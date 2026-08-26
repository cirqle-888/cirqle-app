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
import { loadMyWork } from '@/lib/requests/my-work-load'
import {
  stageOf, stageOfPlan, canMove, STAGE_TARGET_STATUS, STAGE_LABEL,
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
  /** Which queue this came from. A designer should not have to care, but the
   *  move path differs: a request drives a promoted task, a plan item becomes
   *  one directly (no request, no REQ number). */
  source: 'request' | 'plan'
  ref_no: number | null
  title: string
  description: string | null
  /** Request status for 'request'; the linked task's status (or null) for 'plan'. */
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
  const rows = await loadMyWork(createAdminClient(), guard.employeeId)
  return { ok: true, data: rows }
}

/** A PostgREST row whose shape we know but whose generated types cannot
 *  express a string-built select. One narrow alias beats scattering `any`. */
type Row = Record<string, unknown> & { [k: string]: any }   // eslint-disable-line @typescript-eslint/no-explicit-any

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
  req: Row,
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
  requestId: string, toStage: WorkStage, source: 'request' | 'plan' = 'request',
): Promise<ActionResult<{ status: string; taskCreated?: boolean; warning?: string }>> {
  const guard = await requirePermission(PERMS.REQUESTS_WORK_OWN)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (source === 'plan') return movePlanItem(requestId, toStage, guard.employeeId)

  const admin = createAdminClient()
  const { data: req, error } = await admin
    .from('task_requests')
    .select('id, ref_no, title, description, status, assigned_employee_id, promoted_task_id, client_id, service_id, due_date')
    .eq('id', requestId).maybeSingle()
  if (error || !req) return { ok: false, error: 'That work item could not be found.' }

  // The check the permission cannot make. Admins are NOT exempt here: an admin
  // moving someone else's card should do it from the inbox, where the action is
  // logged as an inbox change rather than as the assignee's own progress.
  if ((req as Row).assigned_employee_id !== guard.employeeId) {
    return { ok: false, error: 'This work is assigned to someone else.' }
  }

  const from = stageOf((req as Row).status)
  if (from === toStage) return { ok: true, data: { status: (req as Row).status } }
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
    action: 'updated', category: 'crm', clientId: (req as Row).client_id ?? null,
    note: `My Work: ${(req as Row).ref_no ? `REQ-${String((req as Row).ref_no).padStart(4, '0')}` : 'request'} → ${STAGE_LABEL[toStage]}`,
    detail: { requestId, from, to: toStage, taskStatus, taskCreated: created },
  })

  revalidatePath(REVALIDATE); revalidatePath('/dashboard/requests'); revalidatePath('/dashboard/tasks')
  return { ok: true, data: { status: target, taskCreated: created, warning } }
}

/**
 * Move a CALENDAR PLAN ITEM. Same board, different plumbing.
 *
 * A plan item has no request behind it, so there is nothing to promote and no
 * REQ number to mint — it goes straight to a task, which is the second exit
 * added in e7d9b7b. That is deliberate and is the whole "stop doing the same
 * work twice" point: the planner already described the job on the calendar, so
 * starting it should not require re-typing it into Requests first.
 *
 * The task carries the item's own service and date, and is priced from the
 * matrix exactly like the request path.
 */
async function movePlanItem(
  itemId: string, toStage: WorkStage, employeeId: string,
): Promise<ActionResult<{ status: string; taskCreated?: boolean; warning?: string }>> {
  const admin = createAdminClient()

  const { data: item, error } = await admin
    .from('social_calendar_items')
    .select('id, title, caption, notes, scheduled_date, status, service_id, assigned_employee_id, request_id, task_id, ' +
      'task:tasks!social_calendar_items_task_id_fkey(id, status, deleted_at), ' +
      'calendar:social_calendars(client_id)')
    .eq('id', itemId).maybeSingle()
  if (error || !item) return { ok: false, error: 'That plan item could not be found.' }

  const it = item as unknown as Row
  if (it.assigned_employee_id !== employeeId) {
    return { ok: false, error: 'This work is assigned to someone else.' }
  }
  if (it.request_id) {
    return { ok: false, error: 'This item went to Requests — move it from the request card instead.' }
  }

  const live = it.task && !it.task.deleted_at ? it.task : null
  const from = stageOfPlan(live?.status)
  if (from === toStage) return { ok: true, data: { status: live?.status ?? '' } }
  if (!canMove(from, toStage)) return { ok: false, error: moveRefusalReason(from, toStage) }

  const taskStatus = STAGE_TASK_STATUS[toStage]
  if (!taskStatus) return { ok: false, error: moveRefusalReason(from, toStage) }

  let taskId: string = live?.id
  let created = false
  let warning: string | undefined

  if (!taskId) {
    const cal = Array.isArray(it.calendar) ? it.calendar[0] : it.calendar
    const clientId = cal?.client_id ?? null
    const maxRow = await admin.from('tasks')
      .select('task_number').order('task_number', { ascending: false, nullsFirst: false })
      .limit(1).maybeSingle()
    const { data: task, error: tErr } = await admin.from('tasks').insert({
      task_number: nextTaskNumber(maxRow.data?.task_number),
      title: it.title,
      description: it.caption || it.notes || null,
      client_id: clientId,
      service_id: it.service_id ?? null,
      task_date: it.scheduled_date || todayISO(),
      status: taskStatus,
      quantity: 1, billing_amount: 0, billing_amount_inr: 0,
    }).select('id').single()
    if (tErr || !task) return { ok: false, error: tErr?.message || 'Could not create the task.' }
    taskId = task.id
    created = true

    // Claim the item for the task. Conditional, so two concurrent moves cannot
    // both attach — the loser cleans up the task it just made rather than
    // leaving a duplicate behind.
    const { data: claimed } = await admin.from('social_calendar_items')
      .update({ task_id: taskId, status: 'tasked', updated_at: new Date().toISOString() })
      .eq('id', itemId).is('task_id', null)
      .select('id')
    if (!claimed?.length) {
      await admin.from('tasks').delete().eq('id', taskId)
      return { ok: false, error: 'Someone else started this item — reload the board.' }
    }

    try {
      await serverFillTaskBilling(taskId, clientId, it.service_id ?? null, 1)
    } catch {
      warning = 'The task was created but could not be priced automatically — a manager should set its amount.'
    }
  } else {
    const { error: uErr } = await admin.from('tasks')
      .update({ status: taskStatus, updated_at: new Date().toISOString() })
      .eq('id', taskId)
    if (uErr) return { ok: false, error: 'Could not update the task status. Try again.' }
  }

  void logActivity({
    actorId: employeeId, entityType: 'task', entityId: taskId,
    action: created ? 'created' : 'updated', category: 'crm',
    note: `My Work: plan item → ${STAGE_LABEL[toStage]}`,
    detail: { itemId, from, to: toStage, taskStatus, taskCreated: created },
  })

  revalidatePath(REVALIDATE)
  revalidatePath('/dashboard/social-calendar'); revalidatePath('/dashboard/tasks')
  return { ok: true, data: { status: taskStatus, taskCreated: created, warning } }
}
