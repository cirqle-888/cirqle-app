'use server'

/**
 * Requests Inbox — staff actions. Gated on the requests.* permission keys.
 * Status milestones that are external-facing log client/agency-visible
 * activity; everything else stays internal. Completed/Delivered fire the
 * minimal requester email (design §10).
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission, resolveCurrentEmployeeId } from '@/lib/auth/enforce'
import { PERMS } from '@/lib/permissions/keys'
import {
  setRequestStatus, logRequestActivity, requestStatusFromTask, type RequestStatus,
} from '@/lib/requests/core'
import { notifyRequesterStatus } from '@/lib/requests/notify'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }
const REVALIDATE = '/dashboard/requests'

/** Map each staff status action to the permission it needs. */
const STATUS_PERM: Partial<Record<RequestStatus, string>> = {
  under_review:        PERMS.REQUESTS_REVIEW,
  approved:            PERMS.REQUESTS_REVIEW,
  rejected:            PERMS.REQUESTS_REVIEW,
  waiting_for_content: PERMS.REQUESTS_MANAGE,
  revision_requested:  PERMS.REQUESTS_MANAGE,
  in_progress:         PERMS.REQUESTS_MANAGE,   // manual "Reopen" override (no-task requests)
  completed:           PERMS.REQUESTS_MANAGE,
  delivered:           PERMS.REQUESTS_MANAGE,
  archived:            PERMS.REQUESTS_MANAGE,
  cancelled:           PERMS.REQUESTS_MANAGE,   // "cancel anytime" (needs migration 20260612120000)
  submitted:           PERMS.REQUESTS_MANAGE,   // unarchive → back to the New tab
}

export async function setRequestStatusAction(
  requestId: string, status: RequestStatus,
): Promise<ActionResult> {
  const perm = STATUS_PERM[status]
  if (!perm) return { ok: false, error: 'This status is set by the system.' }
  const guard = await requirePermission(perm)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const ok = await setRequestStatus(admin, requestId, status, { type: 'admin', id: guard.employeeId, label: 'Cirqle' })
  if (!ok) return { ok: false, error: 'Could not update the request status.' }

  // Milestone emails (fire-and-forget).
  if (status === 'completed' || status === 'delivered') {
    const { data: req } = await admin
      .from('task_requests')
      .select('id, ref_no, title, track_token, source, client_id, agency_id, submitter_email')
      .eq('id', requestId).single()
    if (req) void notifyRequesterStatus(req as any, status)
  }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * Bulk status change — loops setRequestStatusAction per request rather than
 * writing a separate bulk SQL path, so every per-row side effect (milestone
 * emails on completed/delivered, activity logging, permission check per
 * target status) stays IDENTICAL to the single-request action. Returns which
 * ids failed (if any) so the UI can report a partial-failure count.
 */
export async function bulkSetRequestStatus(
  requestIds: string[], status: RequestStatus,
): Promise<ActionResult<{ succeeded: string[]; failed: string[] }>> {
  if (!requestIds.length) return { ok: false, error: 'No requests selected.' }
  const succeeded: string[] = []
  const failed: string[] = []
  for (const id of requestIds) {
    const res = await setRequestStatusAction(id, status)
    if (res.ok) succeeded.push(id)
    else failed.push(id)
  }
  return { ok: failed.length === 0, data: { succeeded, failed }, error: failed.length ? `${failed.length} could not be updated` : undefined }
}

/** Bulk assign/reassign — same reuse approach as bulkSetRequestStatus. */
export async function bulkAssignRequestEmployee(
  requestIds: string[], employeeId: string | null, employeeName?: string | null,
): Promise<ActionResult<{ succeeded: string[]; failed: string[] }>> {
  if (!requestIds.length) return { ok: false, error: 'No requests selected.' }
  const succeeded: string[] = []
  const failed: string[] = []
  for (const id of requestIds) {
    const res = await assignRequestEmployee(id, employeeId, employeeName)
    if (res.ok) succeeded.push(id)
    else failed.push(id)
  }
  return { ok: failed.length === 0, data: { succeeded, failed }, error: failed.length ? `${failed.length} could not be updated` : undefined }
}

/** Staff opened a request — clears the "new external activity" indicator. */
export async function markRequestViewed(requestId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.REQUESTS_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  await admin.from('task_requests')
    .update({ last_staff_viewed_at: new Date().toISOString() })
    .eq('id', requestId)
  return { ok: true }
}

/** Full timeline (internal view) — all visibilities. */
export async function getRequestTimeline(requestId: string): Promise<ActionResult<{ rows: any[]; revisions: any[] }>> {
  const guard = await requirePermission(PERMS.REQUESTS_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const [acts, revs] = await Promise.all([
    admin.from('request_activity')
      .select('id, actor_type, actor_label, action, visibility, detail, created_at')
      .eq('request_id', requestId).order('created_at', { ascending: false }).limit(200),
    admin.from('request_revisions')
      .select('id, requested_by_type, note, link, status, created_at')
      .eq('request_id', requestId).order('created_at', { ascending: false }),
  ])
  return { ok: true, data: { rows: acts.data || [], revisions: revs.data || [] } }
}

/** Post a requester-visible update ("Waiting for your content…"). */
export async function postExternalUpdate(
  requestId: string, message: string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.REQUESTS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const msg = (message || '').trim()
  if (!msg) return { ok: false, error: 'Write a message first.' }

  const admin = createAdminClient()
  const { data: req } = await admin.from('task_requests').select('source').eq('id', requestId).single()
  if (!req) return { ok: false, error: 'Request not found.' }

  await logRequestActivity(admin, {
    requestId, actorType: 'admin', actorId: guard.employeeId, actorLabel: 'Cirqle',
    action: 'note',
    visibility: req.source === 'agency' ? 'agency' : 'client',
    detail: { message: msg.slice(0, 1000) },
  })
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * Append an internal-only log note to the request timeline (Odoo-style comment).
 * Visibility is always 'internal' — never reaches the client/agency portal, so
 * the external-projection invariant holds. The note is attributed to the acting
 * staff member's CQID so the timeline shows who wrote what.
 */
export async function postRequestNote(
  requestId: string, note: string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.REQUESTS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const msg = (note || '').trim()
  if (!msg) return { ok: false, error: 'Write a note first.' }

  const admin = createAdminClient()
  // Resolve the actor's CQID for the timeline label (internal-only, so safe).
  let label = 'Cirqle'
  try {
    const { data: emp } = await admin.from('employees').select('cqid').eq('id', guard.employeeId).single()
    if (emp?.cqid) label = emp.cqid
  } catch { /* fall back to 'Cirqle' */ }

  await logRequestActivity(admin, {
    requestId, actorType: 'admin', actorId: guard.employeeId, actorLabel: label,
    action: 'note', visibility: 'internal',
    detail: { message: msg.slice(0, 1000) },
  })
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** Internal-only note (never visible externally). */
export async function updateInternalNotes(
  requestId: string, notes: string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.REQUESTS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('task_requests')
    .update({ internal_notes: (notes || '').trim() || null, updated_at: new Date().toISOString() })
    .eq('id', requestId)
  if (error) return { ok: false, error: error.message }
  await logRequestActivity(admin, {
    requestId, actorType: 'admin', actorId: guard.employeeId, actorLabel: 'Cirqle',
    action: 'internal_note_updated', visibility: 'internal',
  })
  return { ok: true }
}

/**
 * Promotion (design §5): called AFTER the prefilled Add Task modal actually
 * creates the task. Links the request to the task, sets status = started,
 * logs the promotion (internal) + Started milestone (requester-visible),
 * and fires the "started" email.
 */
export async function markRequestPromoted(
  requestId: string, taskId: string, taskNumber: number | null,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.REQUESTS_START)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: req, error } = await admin
    .from('task_requests')
    .select('id, ref_no, title, status, source, track_token, client_id, agency_id, submitter_email, promoted_task_id, assigned_employee_id')
    .eq('id', requestId).single()
  if (error || !req) return { ok: false, error: 'Request not found.' }
  if (req.promoted_task_id) return { ok: false, error: 'This request was already promoted.' }

  const { error: upErr } = await admin.from('task_requests').update({
    promoted_task_id: taskId,
    promoted_at: new Date().toISOString(),
    promoted_by: guard.employeeId,
    status: 'started',
    client_status: 'started',
    status_updated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', requestId)
  if (upErr) return { ok: false, error: upErr.message }

  // Carry the request's planned assignee onto the new task (plain assignment —
  // contribution scoring still happens in the task's Contributions tab).
  if (req.assigned_employee_id) {
    try {
      await admin.from('task_assignments')
        .insert({ task_id: taskId, employee_id: req.assigned_employee_id })
    } catch { /* best-effort */ }
  }

  // Internal promotion record + requester-visible Started milestone.
  await logRequestActivity(admin, {
    requestId, actorType: 'admin', actorId: guard.employeeId, actorLabel: 'Cirqle',
    action: 'promoted', visibility: 'internal',
    detail: { task_id: taskId, task_number: taskNumber },
  })
  await logRequestActivity(admin, {
    requestId, actorType: 'admin', actorId: guard.employeeId, actorLabel: 'Cirqle',
    action: 'status_changed',
    visibility: req.source === 'agency' ? 'agency' : 'client',
    detail: { from: req.status, to: 'started' },
  })
  void notifyRequesterStatus(req as any, 'started')

  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * Assign (or clear) an employee on a request. Pre-promotion this is just a
 * planning marker — it does NOT create a task or task_assignment. When the
 * request is started (promoted), markRequestPromoted carries it onto the task.
 */
export async function assignRequestEmployee(
  requestId: string, employeeId: string | null, employeeName?: string | null,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.REQUESTS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('task_requests')
    .update({ assigned_employee_id: employeeId, updated_at: new Date().toISOString() })
    .eq('id', requestId)
  if (error) return { ok: false, error: error.message }
  await logRequestActivity(admin, {
    requestId, actorType: 'admin', actorId: guard.employeeId, actorLabel: 'Cirqle',
    action: employeeId ? 'assigned' : 'unassigned', visibility: 'internal',
    detail: employeeId ? { employee_id: employeeId, employee_name: employeeName || null } : null,
  })
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * Staff-created request (source = 'manual') — the "opportunity inbox" entry.
 * Lands in the New tab exactly like a client submission and, because the
 * portal scopes client links by client_id, it automatically appears on that
 * client's intake page ("Track My Requests") too. It only becomes a task
 * (and gets a task number) when someone presses Start.
 */
const OPEN_STATUSES = ['submitted', 'under_review', 'approved', 'started', 'in_progress', 'waiting_for_content', 'revision_requested']

export async function createManualRequest(input: {
  clientId: string
  title: string
  description?: string
  designPlan?: string
  remarks?: string
  contentLink?: string
  referenceLink?: string
  extraLinks?: { label: string; url: string }[]
  isPlanned?: boolean
  serviceId?: string | null
  priority?: string
  dueDate?: string | null
  assignedEmployeeId?: string | null
  estimatedValue?: number | null
}): Promise<ActionResult<any>> {
  const guard = await requirePermission(PERMS.REQUESTS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const title = (input.title || '').trim()
  if (!title) return { ok: false, error: 'Title is required.' }
  if (!input.clientId) return { ok: false, error: 'Pick a client — the request shows on their intake portal.' }

  const admin = createAdminClient()
  const now = new Date().toISOString()

  // Same rule as the intake form: join the END of the client's open queue.
  let nextRank: number | null = null
  try {
    const { count } = await admin.from('task_requests')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', input.clientId)
      .in('status', OPEN_STATUSES)
    nextRank = (count ?? 0) + 1
  } catch { /* defensive */ }

  const payload: Record<string, unknown> = {
    source: 'manual',
    client_id: input.clientId,
    title,
    description: (input.description || '').trim() || null,
    design_plan: (input.designPlan || '').trim() || null,
    remarks: (input.remarks || '').trim() || null,
    content_link: (input.contentLink || '').trim() || null,
    reference_link: (input.referenceLink || '').trim() || null,
    extra_links: (input.extraLinks || []).filter(l => l.url?.trim()).slice(0, 10),
    is_planned: !!input.isPlanned,
    service_id: input.serviceId || null,
    priority: ['low', 'normal', 'high', 'urgent'].includes(input.priority || '') ? input.priority : 'normal',
    priority_rank: nextRank,
    due_date: input.dueDate || null,
    assigned_employee_id: input.assignedEmployeeId || null,
    status: 'submitted',
    client_status: 'submitted',
    // Staff created it — don't let it flag itself as "new external activity".
    last_staff_viewed_at: now,
  }
  if (input.estimatedValue != null && !isNaN(input.estimatedValue)) payload.estimated_value = input.estimatedValue
  const SELECT_COLS = '*, client:clients(id, name, code), agency:agencies(id, name), service:services(id, name), assigned_employee:employees!task_requests_assigned_employee_id_fkey(id, name), promoted_task:tasks!task_requests_promoted_task_id_fkey(id, task_number, title, status)'
  let { data, error } = await admin.from('task_requests').insert(payload).select(SELECT_COLS).single()
  // Graceful pre-patch fallbacks: columns from later migrations may be missing.
  if (error && /priority_rank/i.test(error.message || '')) {
    delete payload.priority_rank
    ;({ data, error } = await admin.from('task_requests').insert(payload).select(SELECT_COLS).single())
  }
  if (error && /estimated_value/i.test(error.message || '')) {
    delete payload.estimated_value
    ;({ data, error } = await admin.from('task_requests').insert(payload).select(SELECT_COLS).single())
  }
  if (error || !data) return { ok: false, error: error?.message || 'Could not create the request.' }

  // Client-visible "submitted" entry so it reads naturally on their portal timeline.
  await logRequestActivity(admin, {
    requestId: data.id, actorType: 'admin', actorId: guard.employeeId, actorLabel: 'Cirqle',
    action: 'submitted', visibility: 'client', detail: { title },
  })

  revalidatePath(REVALIDATE)
  return { ok: true, data }
}

/**
 * Search tasks to link to a request (tasks already created on the Tasks page).
 * Excludes deleted tasks and tasks already linked to another request.
 * "#42" → exact task-number; otherwise title match (and number prefix).
 */
export async function searchTasksForLink(
  q: string, clientId?: string | null,
): Promise<ActionResult<any[]>> {
  const guard = await requirePermission(PERMS.REQUESTS_START)
  if (!guard.ok) return { ok: false, error: guard.error }
  const query = (q || '').trim()
  if (!query) return { ok: true, data: [] }

  const admin = createAdminClient()
  let builder = admin.from('tasks')
    .select('id, task_number, title, status, task_date, client:clients(id, name)')
    .is('deleted_at', null)
    .order('task_date', { ascending: false })
    .limit(25)
  if (clientId) builder = builder.eq('client_id', clientId)
  const num = query.startsWith('#') ? parseInt(query.slice(1), 10) : (/^\d+$/.test(query) ? parseInt(query, 10) : NaN)
  if (!isNaN(num)) builder = builder.eq('task_number', num)
  else builder = builder.ilike('title', `%${query}%`)

  const [{ data: tasks, error }, linked] = await Promise.all([
    builder,
    admin.from('task_requests').select('promoted_task_id').not('promoted_task_id', 'is', null),
  ])
  if (error) return { ok: false, error: error.message }
  const linkedIds = new Set((linked.data || []).map((r: any) => r.promoted_task_id))
  return { ok: true, data: (tasks || []).filter((t: any) => !linkedIds.has(t.id)).slice(0, 10) }
}

/**
 * Link an EXISTING task to a request (work already started on the Tasks page
 * before the request was promoted). Same semantics as Start — sets started,
 * logs + emails — then mirrors the task's current status onto the request
 * (e.g. linking an already-done task lands the request on Completed).
 */
export async function linkRequestToTask(
  requestId: string, taskId: string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.REQUESTS_START)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: task, error } = await admin.from('tasks')
    .select('id, task_number, status, deleted_at')
    .eq('id', taskId).maybeSingle()
  if (error || !task || task.deleted_at) return { ok: false, error: 'Task not found.' }
  const { data: taken } = await admin.from('task_requests')
    .select('id, ref_no').eq('promoted_task_id', taskId).maybeSingle()
  if (taken && taken.id !== requestId) {
    return { ok: false, error: `That task is already linked to ${`REQ-${String(taken.ref_no ?? 0).padStart(4, '0')}`}.` }
  }

  const res = await markRequestPromoted(requestId, taskId, task.task_number ?? null)
  if (!res.ok) return res

  // Mirror the task's current status (it may already be past "started").
  const mirrored = requestStatusFromTask(task.status)
  if (mirrored && mirrored !== 'started') {
    await setRequestStatus(admin, requestId, mirrored, { type: 'admin', id: guard.employeeId, label: 'Cirqle' })
  }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * Request brief for a promoted task — readable by ANY signed-in employee so
 * designers can open the client's design plan / links straight from the task
 * card. Returns staff-safe fields only (internal_notes stay manager-side).
 */
export async function getRequestBriefForTask(taskId: string): Promise<ActionResult<any>> {
  const employeeId = await resolveCurrentEmployeeId()
  if (!employeeId) return { ok: false, error: 'Not signed in.' }
  const admin = createAdminClient()
  try {
    const { data } = await admin.from('task_requests')
      .select('id, ref_no, title, description, design_plan, remarks, priority, due_date, status, source, created_at, ' +
        'content_link, reference_link, deliverables_link, drive_folder_link, extra_links, ' +
        'client:clients(id, name, code), agency:agencies(id, name), service:services(id, name), ' +
        'assigned_employee:employees!task_requests_assigned_employee_id_fkey(id, name)')
      .eq('promoted_task_id', taskId).maybeSingle()
    if (!data) return { ok: false, error: 'No request linked to this task.' }
    return { ok: true, data }
  } catch { return { ok: false, error: 'Request portal not set up.' } }
}

/** Close a revision item. */
export async function markRevisionAddressed(revisionId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.REQUESTS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('request_revisions')
    .update({ status: 'addressed', resolved_at: new Date().toISOString() })
    .eq('id', revisionId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * Staff priority reorder — updates priority_rank for each request in the
 * supplied ordered array. Called from the drag-and-drop list on the Requests
 * page (and manual rank override). Rank 1 = highest priority.
 */
export async function reorderStaffPriority(requestIds: string[]): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.REQUESTS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!requestIds.length) return { ok: true }
  const admin = createAdminClient()
  const now = new Date().toISOString()
  await Promise.all(
    requestIds.map((id, i) =>
      admin.from('task_requests')
        .update({ priority_rank: i + 1, updated_at: now })
        .eq('id', id)
    )
  )
  revalidatePath(REVALIDATE)
  return { ok: true }
}
