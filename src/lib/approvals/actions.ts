'use server'

/**
 * Approval engine server actions (Cirqle Connect Wave B).
 *
 * Rules enforced here (single enforcement point — SECURITY_REVIEW.md §4):
 *   • requesting needs 'approvals.request' (admins pass)
 *   • deciding needs eligibility: named approver / member of the approver
 *     designation / holder of the approver permission / 'approvals.decide_all'
 *   • the requester can NEVER decide their own request (admins included)
 *   • a pending approval is decided exactly once (optimistic status guard)
 *   • approval_events is append-only (no update/delete paths exist)
 *
 * Chat: requesting posts a kind='approval' message into the chosen
 * conversation; decisions update that message's metadata so open chat
 * clients re-render the card live via the existing realtime subscription.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission, type CurrentUser } from '@/lib/permissions/check'
import { logActivity } from '@/lib/activity/log'
import { createNotification } from '@/lib/notifications/create'
import { runApprovalEffect, type ApprovalDecision } from './effects'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'changes_requested' | 'cancelled'

export interface ApprovalSummary {
  id: string
  entityType: string
  entityId: string | null
  title: string
  description: string | null
  status: ApprovalStatus
  requestedBy: { id: string; name: string; cqid: string }
  decidedBy: { id: string; name: string; cqid: string } | null
  approverLabel: string
  conversationId: string | null
  dueAt: string | null
  createdAt: string
  decidedAt: string | null
  /** True when the CALLER may decide this approval right now. */
  canDecide: boolean
}

export interface ApprovalEvent {
  id: string
  event: string
  comment: string | null
  actor: { id: string; name: string; cqid: string } | null
  versionNo: number | null
  createdAt: string
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

// ── Internal ──────────────────────────────────────────────────────────────────

async function requireUser() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) return { ok: false as const, error: 'Not signed in.' }
  return { ok: true as const, me }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function canDecideRow(me: CurrentUser, row: any): boolean {
  if (row.status !== 'pending') return false
  if (row.requested_by === me.employeeId) return false // never your own
  if (me.isAdmin || hasPermission(me, 'approvals.decide_all')) return true
  if (row.approver_employee_id && row.approver_employee_id === me.employeeId) return true
  if (row.approver_designation_id && row.approver_designation_id === me.designationId) return true
  if (row.approver_permission && hasPermission(me, row.approver_permission)) return true
  return false
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function approverLabel(row: any): string {
  const emp = Array.isArray(row.approver_employee) ? row.approver_employee[0] : row.approver_employee
  const des = Array.isArray(row.approver_designation) ? row.approver_designation[0] : row.approver_designation
  if (emp?.cqid || emp?.name) return `${emp?.cqid ?? ''}||${emp?.name ?? ''}`
  if (des?.name) return `Any ${des.name}`
  if (row.approver_permission) return `Anyone with ${row.approver_permission}`
  return 'Any admin'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapApproval(me: CurrentUser, r: any): ApprovalSummary {
  const req = Array.isArray(r.requester) ? r.requester[0] : r.requester
  const dec = Array.isArray(r.decider) ? r.decider[0] : r.decider
  return {
    id: r.id,
    entityType: r.entity_type,
    entityId: r.entity_id ?? null,
    title: r.title,
    description: r.description ?? null,
    status: r.status,
    requestedBy: { id: r.requested_by, name: req?.name ?? '', cqid: req?.cqid ?? '' },
    decidedBy: dec ? { id: r.decided_by, name: dec.name ?? '', cqid: dec.cqid ?? '' } : null,
    approverLabel: approverLabel(r),
    conversationId: r.conversation_id ?? null,
    dueAt: r.due_at ?? null,
    createdAt: r.created_at,
    decidedAt: r.decided_at ?? null,
    canDecide: canDecideRow(me, r),
  }
}

const APPROVAL_SELECT = `
  id, entity_type, entity_id, title, description, status,
  approver_employee_id, approver_designation_id, approver_permission,
  client_id, project_id, task_id, conversation_id, message_id,
  requested_by, decided_by, decided_at, due_at, created_at,
  requester:requested_by(name, cqid),
  decider:decided_by(name, cqid),
  approver_employee:approver_employee_id(name, cqid),
  approver_designation:approver_designation_id(name)
`

/** Resolve the employees who should be notified for an approval's rule. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function eligibleApproverIds(admin: any, row: {
  approver_employee_id: string | null
  approver_designation_id: string | null
  approver_permission: string | null
}): Promise<string[]> {
  if (row.approver_employee_id) return [row.approver_employee_id]
  if (row.approver_designation_id) {
    const { data } = await admin.from('employees')
      .select('id').eq('designation_id', row.approver_designation_id)
      .or('is_archived.is.null,is_archived.eq.false')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data ?? []).map((e: any) => e.id)
  }
  // Permission rule or default "any admin": notify admins (permission holders
  // resolve lazily at decide time; notifying every holder needs a join we
  // keep for v2 — admins always qualify).
  const { data } = await admin.from('employees')
    .select('id, designation:designation_id(is_admin)')
    .or('is_archived.is.null,is_archived.eq.false')
  return (data ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((e: any) => {
      const d = Array.isArray(e.designation) ? e.designation[0] : e.designation
      return d?.is_admin === true || !d
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((e: any) => e.id)
}

// ── Request ───────────────────────────────────────────────────────────────────

export async function requestApproval(input: {
  entityType: string
  entityId?: string | null
  title: string
  description?: string
  approver: { employeeId?: string; designationId?: string; permission?: string }
  conversationId?: string | null
  dueAt?: string | null
  clientId?: string | null
  projectId?: string | null
  taskId?: string | null
}): Promise<Result<{ approvalId: string; messageId: string | null }>> {
  const auth = await requireUser()
  if (!auth.ok) return auth
  const me = auth.me
  if (!me.isAdmin && !hasPermission(me, 'approvals.request')) {
    return { ok: false, error: 'You do not have permission to request approvals.' }
  }
  const title = (input.title || '').trim()
  if (!title) return { ok: false, error: 'A title is required.' }

  const admin = createAdminClient()

  // Chat card first (so the approval row can reference it)
  let messageId: string | null = null
  if (input.conversationId) {
    const { data: member } = await admin
      .from('conversation_members').select('employee_id')
      .eq('conversation_id', input.conversationId)
      .eq('employee_id', me.employeeId).maybeSingle()
    if (!member) return { ok: false, error: 'You are not a member of that conversation.' }
    const { data: msg, error: msgErr } = await admin.from('messages').insert({
      conversation_id: input.conversationId,
      sender_id: me.employeeId,
      kind: 'approval',
      body: title,
      metadata: { approvalStatus: 'pending' },
    }).select('id').single()
    if (msgErr) return { ok: false, error: msgErr.message }
    messageId = msg.id
  }

  const { data: appr, error } = await admin.from('approvals').insert({
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    title,
    description: (input.description || '').trim() || null,
    approver_employee_id: input.approver.employeeId ?? null,
    approver_designation_id: input.approver.designationId ?? null,
    approver_permission: input.approver.permission ?? null,
    conversation_id: input.conversationId ?? null,
    message_id: messageId,
    client_id: input.clientId ?? null,
    project_id: input.projectId ?? null,
    task_id: input.taskId ?? null,
    requested_by: me.employeeId,
    due_at: input.dueAt ?? null,
  }).select('id, approver_employee_id, approver_designation_id, approver_permission').single()
  if (error) return { ok: false, error: error.message }

  // Link the chat card to its approval
  if (messageId) {
    void admin.from('messages')
      .update({ metadata: { approvalStatus: 'pending', approvalId: appr.id } })
      .eq('id', messageId).then(undefined, () => {})
  }

  // History + timeline + notifications
  void admin.from('approval_events').insert({
    approval_id: appr.id, actor_id: me.employeeId, event: 'requested',
  }).then(undefined, () => {})
  void logActivity({
    actorId: me.employeeId, entityType: 'approval', entityId: appr.id,
    action: 'requested', clientId: input.clientId ?? null,
    projectId: input.projectId ?? null, taskId: input.taskId ?? null,
    conversationId: input.conversationId ?? null, detail: { label: title },
  })
  const approverIds = await eligibleApproverIds(admin, appr)
  for (const empId of approverIds) {
    if (empId === me.employeeId) continue
    void createNotification({
      employeeId: empId,
      type: 'approval_requested',
      title: `Approval needed: ${title}`,
      message: `Requested by ${me.name || me.cqid}`,
      link: input.conversationId ? `/dashboard/chat?c=${input.conversationId}` : '/dashboard/approvals',
      sourceKey: `approval:${appr.id}:requested:${empId}`,
    })
  }

  return { ok: true, data: { approvalId: appr.id, messageId } }
}

// ── Decide ────────────────────────────────────────────────────────────────────

export async function decideApproval(input: {
  approvalId: string
  decision: ApprovalDecision
  comment?: string
}): Promise<Result<{ status: ApprovalStatus }>> {
  const auth = await requireUser()
  if (!auth.ok) return auth
  const me = auth.me

  const admin = createAdminClient()
  const { data: row } = await admin
    .from('approvals').select(APPROVAL_SELECT).eq('id', input.approvalId).maybeSingle()
  if (!row) return { ok: false, error: 'Approval not found.' }
  if (row.status !== 'pending') return { ok: false, error: `Already ${row.status.replace('_', ' ')}.` }
  if (!canDecideRow(me, row)) {
    return {
      ok: false,
      error: row.requested_by === me.employeeId
        ? 'You cannot decide your own request.'
        : 'You are not an eligible approver for this request.',
    }
  }

  // Optimistic single-decision guard: only flips if still pending.
  const now = new Date().toISOString()
  const { data: updated, error } = await admin
    .from('approvals')
    .update({ status: input.decision, decided_by: me.employeeId, decided_at: now, updated_at: now })
    .eq('id', input.approvalId)
    .eq('status', 'pending')
    .select('id')
  if (error) return { ok: false, error: error.message }
  if (!updated?.length) return { ok: false, error: 'Someone else just decided this request.' }

  void admin.from('approval_events').insert({
    approval_id: input.approvalId, actor_id: me.employeeId,
    event: input.decision, comment: (input.comment || '').trim() || null,
  }).then(undefined, () => {})

  // Live-update the chat card
  if (row.message_id) {
    void admin.from('messages')
      .update({ metadata: { approvalStatus: input.decision, approvalId: input.approvalId, decidedByName: me.name } })
      .eq('id', row.message_id).then(undefined, () => {})
  }

  void logActivity({
    actorId: me.employeeId, entityType: 'approval', entityId: input.approvalId,
    action: input.decision, clientId: row.client_id ?? null,
    projectId: row.project_id ?? null, taskId: row.task_id ?? null,
    conversationId: row.conversation_id ?? null, detail: { label: row.title },
  })
  void createNotification({
    employeeId: row.requested_by,
    type: 'approval_decided',
    title: `${input.decision === 'approved' ? '✅ Approved' : input.decision === 'rejected' ? '❌ Rejected' : '✏️ Changes requested'}: ${row.title}`,
    message: input.comment || `by ${me.name || me.cqid}`,
    link: row.conversation_id ? `/dashboard/chat?c=${row.conversation_id}` : '/dashboard/approvals',
    sourceKey: `approval:${input.approvalId}:decided`,
  })

  // Entity side effect (best-effort, never blocks)
  void runApprovalEffect(row.entity_type, {
    entityId: row.entity_id ?? null, decision: input.decision, decidedBy: me.employeeId,
  })

  return { ok: true, data: { status: input.decision } }
}

// ── Comment / cancel ─────────────────────────────────────────────────────────

export async function commentOnApproval(approvalId: string, comment: string): Promise<Result<null>> {
  const auth = await requireUser()
  if (!auth.ok) return auth
  const text = (comment || '').trim()
  if (!text) return { ok: false, error: 'Comment is empty.' }

  const admin = createAdminClient()
  const { data: row } = await admin.from('approvals')
    .select(APPROVAL_SELECT).eq('id', approvalId).maybeSingle()
  if (!row) return { ok: false, error: 'Approval not found.' }
  const involved = row.requested_by === auth.me.employeeId || canDecideRow(auth.me, { ...row, status: 'pending' })
  if (!involved && !auth.me.isAdmin) return { ok: false, error: 'Not involved in this approval.' }

  const { error } = await admin.from('approval_events').insert({
    approval_id: approvalId, actor_id: auth.me.employeeId, event: 'commented', comment: text,
  })
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: null }
}

export async function cancelApproval(approvalId: string): Promise<Result<null>> {
  const auth = await requireUser()
  if (!auth.ok) return auth
  const me = auth.me
  const admin = createAdminClient()
  const { data: row } = await admin.from('approvals')
    .select('id, status, requested_by, message_id, title').eq('id', approvalId).maybeSingle()
  if (!row) return { ok: false, error: 'Approval not found.' }
  if (row.requested_by !== me.employeeId && !me.isAdmin) {
    return { ok: false, error: 'Only the requester (or an admin) can cancel.' }
  }
  if (row.status !== 'pending') return { ok: false, error: `Already ${row.status.replace('_', ' ')}.` }

  const now = new Date().toISOString()
  const { data: updated, error } = await admin.from('approvals')
    .update({ status: 'cancelled', updated_at: now })
    .eq('id', approvalId).eq('status', 'pending').select('id')
  if (error) return { ok: false, error: error.message }
  if (!updated?.length) return { ok: false, error: 'Someone just decided this request.' }

  void admin.from('approval_events').insert({
    approval_id: approvalId, actor_id: me.employeeId, event: 'cancelled',
  }).then(undefined, () => {})
  if (row.message_id) {
    void admin.from('messages')
      .update({ metadata: { approvalStatus: 'cancelled', approvalId } })
      .eq('id', row.message_id).then(undefined, () => {})
  }
  return { ok: true, data: null }
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function getApprovals(
  view: 'awaiting_me' | 'my_requests',
): Promise<Result<ApprovalSummary[]>> {
  const auth = await requireUser()
  if (!auth.ok) return auth
  const me = auth.me
  const admin = createAdminClient()

  let rows: unknown[] = []
  if (view === 'my_requests') {
    const { data, error } = await admin.from('approvals')
      .select(APPROVAL_SELECT)
      .eq('requested_by', me.employeeId)
      .order('created_at', { ascending: false }).limit(100)
    if (error) return { ok: false, error: error.message }
    rows = data ?? []
  } else {
    // Awaiting me: pending rows I can decide. Broad fetch (pending, not mine),
    // then filter through the same eligibility function used for deciding —
    // one rule implementation, no drift.
    const { data, error } = await admin.from('approvals')
      .select(APPROVAL_SELECT)
      .eq('status', 'pending')
      .neq('requested_by', me.employeeId)
      .order('created_at', { ascending: false }).limit(200)
    if (error) return { ok: false, error: error.message }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rows = (data ?? []).filter((r: any) => canDecideRow(me, r))
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ok: true, data: rows.map((r: any) => mapApproval(me, r)) }
}

export async function getApproval(approvalId: string): Promise<Result<{ approval: ApprovalSummary; events: ApprovalEvent[] }>> {
  const auth = await requireUser()
  if (!auth.ok) return auth
  const admin = createAdminClient()
  const { data: row } = await admin.from('approvals')
    .select(APPROVAL_SELECT).eq('id', approvalId).maybeSingle()
  if (!row) return { ok: false, error: 'Approval not found.' }

  const { data: events } = await admin.from('approval_events')
    .select('id, event, comment, version_no, created_at, actor:actor_id(id, name, cqid)')
    .eq('approval_id', approvalId)
    .order('created_at', { ascending: true })

  return {
    ok: true,
    data: {
      approval: mapApproval(auth.me, row),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      events: (events ?? []).map((e: any) => {
        const actor = Array.isArray(e.actor) ? e.actor[0] : e.actor
        return {
          id: e.id, event: e.event, comment: e.comment ?? null,
          actor: actor ? { id: actor.id, name: actor.name ?? '', cqid: actor.cqid ?? '' } : null,
          versionNo: e.version_no ?? null, createdAt: e.created_at,
        }
      }),
    },
  }
}

/** Lightweight option lists for the request dialog. */
export async function getApprovalFormOptions(): Promise<Result<{
  employees: { id: string; name: string; cqid: string }[]
  designations: { id: string; name: string }[]
}>> {
  const auth = await requireUser()
  if (!auth.ok) return auth
  const admin = createAdminClient()
  const [{ data: emps }, { data: desigs }] = await Promise.all([
    admin.from('employees').select('id, name, cqid, is_archived')
      .or('is_archived.is.null,is_archived.eq.false').order('name'),
    admin.from('designations').select('id, name').order('name'),
  ])
  return {
    ok: true,
    data: {
      employees: (emps ?? []).filter(e => e.id !== auth.me.employeeId)
        .map(e => ({ id: e.id, name: e.name ?? '', cqid: e.cqid ?? '' })),
      designations: (desigs ?? []).map(d => ({ id: d.id, name: d.name ?? '' })),
    },
  }
}
