'use server'

/**
 * Requests Inbox — staff actions. Gated on the requests.* permission keys.
 * Status milestones that are external-facing log client/agency-visible
 * activity; everything else stays internal. Completed/Delivered fire the
 * minimal requester email (design §10).
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/auth/enforce'
import { PERMS } from '@/lib/permissions/keys'
import {
  setRequestStatus, logRequestActivity, type RequestStatus,
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
  completed:           PERMS.REQUESTS_MANAGE,
  delivered:           PERMS.REQUESTS_MANAGE,
  archived:            PERMS.REQUESTS_MANAGE,
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
