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
import { setRequestStatus } from '@/lib/requests/core'
import { notifyRequesterStatus } from '@/lib/requests/notify'
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

/**
 * Move one of the caller's own requests to a new stage.
 *
 * Four gates, in order — each one is load-bearing:
 *   1. holds requests.work_own
 *   2. the row is assigned to THEM (the permission cannot express this)
 *   3. the stage transition is legal (forward, or Delivered → Working)
 *   4. the stage maps to a status a designer may write
 *
 * The write goes through the house setRequestStatus so client_status, the
 * portal timeline and requester notification behave exactly as they do when a
 * manager makes the same change from the inbox.
 */
export async function moveMyWork(
  requestId: string, toStage: WorkStage,
): Promise<ActionResult<{ status: string }>> {
  const guard = await requirePermission(PERMS.REQUESTS_WORK_OWN)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: req, error } = await admin
    .from('task_requests')
    .select('id, ref_no, title, status, assigned_employee_id')
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

  const target = STAGE_TARGET_STATUS[toStage]
  if (!target) return { ok: false, error: moveRefusalReason(from, toStage) }

  const ok = await setRequestStatus(admin, requestId, target as any, {
    type: 'admin', id: guard.employeeId, label: 'assignee',
  })
  if (!ok) return { ok: false, error: 'Could not update the status. Try again.' }

  // Milestone email, exactly as the inbox sends it. Parity is the point: the
  // client learns their work was delivered because it WAS delivered, not
  // because of who pressed the button. Without this, a designer marking their
  // own card done would leave the requester uninformed where a manager doing
  // the identical thing would not.
  if (target === 'completed' || target === 'delivered') {
    const { data: full } = await admin
      .from('task_requests')
      .select('id, ref_no, title, track_token, source, client_id, agency_id, submitter_email')
      .eq('id', requestId).single()
    if (full) void notifyRequesterStatus(full as any, target as 'completed' | 'delivered')
  }

  void logActivity({
    actorId: guard.employeeId, entityType: 'note', entityId: null,
    action: 'updated', category: 'crm',
    note: `My Work: ${(req as any).ref_no ? `REQ-${String((req as any).ref_no).padStart(4, '0')}` : 'request'} → ${STAGE_LABEL[toStage]}`,
    detail: { requestId, from, to: toStage, status: target },
  })

  revalidatePath(REVALIDATE); revalidatePath('/dashboard/requests')
  return { ok: true, data: { status: target } }
}
