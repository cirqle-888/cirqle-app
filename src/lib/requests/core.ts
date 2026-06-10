import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * External Request Portal — shared core (statuses, projections, activity).
 * See REQUEST_PORTAL_DESIGN.md. Everything here is defensive: if the portal
 * tables don't exist yet (migration not applied), helpers no-op so the rest
 * of the app is unaffected.
 */

// ─── Status model ─────────────────────────────────────────────────────────────

export type RequestStatus =
  | 'submitted' | 'under_review' | 'approved' | 'started' | 'in_progress'
  | 'waiting_for_content' | 'revision_requested' | 'completed' | 'delivered'
  | 'rejected' | 'archived'

export type Visibility = 'internal' | 'client' | 'agency'
export type ActorType = 'client' | 'agency' | 'admin' | 'system'

/** External-facing labels (the ONLY statuses shown on the portal). */
export const CLIENT_STATUS_LABEL: Record<string, string> = {
  submitted:           'Request Submitted',
  under_review:        'Under Review',
  approved:            'Approved',
  started:             'Started',
  in_progress:         'In Progress',
  waiting_for_content: 'Waiting for Content',
  revision_requested:  'Revision Requested',
  completed:           'Completed',
  delivered:           'Delivered',
}

/** Internal status → external `client_status` projection (§3 of the design).
 *  rejected/archived intentionally project to the last public-safe state. */
export function projectClientStatus(status: RequestStatus): string {
  if (status === 'rejected' || status === 'archived') return 'submitted'
  return status
}

/** Internal inbox chip styling per status. */
export const STATUS_CHIP: Record<string, string> = {
  submitted:           'bg-blue-500/12 text-blue-400 border-blue-500/25',
  under_review:        'bg-amber-500/12 text-amber-400 border-amber-500/25',
  approved:            'bg-violet-500/12 text-violet-300 border-violet-500/25',
  started:             'bg-green-500/12 text-green-400 border-green-500/25',
  in_progress:         'bg-green-500/12 text-green-400 border-green-500/25',
  waiting_for_content: 'bg-orange-500/12 text-orange-400 border-orange-500/25',
  revision_requested:  'bg-pink-500/12 text-pink-400 border-pink-500/25',
  completed:           'bg-emerald-500/12 text-emerald-400 border-emerald-500/25',
  delivered:           'bg-emerald-500/12 text-emerald-300 border-emerald-500/25',
  rejected:            'bg-red-500/12 text-red-400 border-red-500/25',
  archived:            'bg-secondary text-muted-foreground border-border',
}

export const PRIORITY_CHIP: Record<string, string> = {
  low:    'text-muted-foreground',
  normal: 'text-foreground/70',
  high:   'text-amber-400',
  urgent: 'text-red-400',
}

export function refLabel(refNo: number | null | undefined): string {
  return `REQ-${String(refNo ?? 0).padStart(4, '0')}`
}

/** Map a promoted task's status onto the request status (mirroring, §3). */
export function requestStatusFromTask(taskStatus: string): RequestStatus | null {
  if (taskStatus === 'pending' || taskStatus === 'in_progress') return 'in_progress'
  if (taskStatus === 'done') return 'completed'
  if (taskStatus === 'delivered' || taskStatus === 'invoiced' || taskStatus === 'paid') return 'delivered'
  return null // cancelled etc. — leave the request as-is
}

// ─── Activity logging (server-side, fire-safe) ────────────────────────────────

export interface ActivityInput {
  requestId: string
  actorType: ActorType
  actorId?: string | null
  actorLabel?: string | null
  action: string
  visibility?: Visibility
  detail?: Record<string, unknown> | null
}

/** Append a timeline entry. Never throws; returns false on failure. */
export async function logRequestActivity(
  admin: SupabaseClient,
  input: ActivityInput,
): Promise<boolean> {
  try {
    const { error } = await admin.from('request_activity').insert({
      request_id: input.requestId,
      actor_type: input.actorType,
      actor_id: input.actorId ?? null,
      actor_label: input.actorLabel ?? null,
      action: input.action,
      visibility: input.visibility ?? 'internal',
      detail: input.detail ?? null,
    })
    return !error
  } catch { return false }
}

/** Bump the external-activity marker that drives the inbox "new update" dot. */
export async function bumpExternalActivity(admin: SupabaseClient, requestId: string) {
  try {
    await admin.from('task_requests')
      .update({ last_external_activity_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', requestId)
  } catch { /* best-effort */ }
}

/** Set status + projection + timestamps, and log it (visibility per external map). */
export async function setRequestStatus(
  admin: SupabaseClient,
  requestId: string,
  status: RequestStatus,
  actor: { type: ActorType; id?: string | null; label?: string | null },
): Promise<boolean> {
  const externalFacing = status in CLIENT_STATUS_LABEL
  try {
    const { data: prev } = await admin.from('task_requests').select('status, source').eq('id', requestId).single()
    const { error } = await admin.from('task_requests').update({
      status,
      client_status: projectClientStatus(status),
      status_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...(status === 'archived' ? { archived_at: new Date().toISOString() } : {}),
    }).eq('id', requestId)
    if (error) return false
    const requesterVisibility: Visibility = prev?.source === 'agency' ? 'agency' : 'client'
    await logRequestActivity(admin, {
      requestId,
      actorType: actor.type, actorId: actor.id, actorLabel: actor.label,
      action: 'status_changed',
      visibility: externalFacing ? requesterVisibility : 'internal',
      detail: { from: prev?.status ?? null, to: status },
    })
    return true
  } catch { return false }
}

/** Count of requests with new external activity (sidebar badge). Defensive. */
export async function countNewExternalActivity(admin: SupabaseClient): Promise<number> {
  try {
    const { data, error } = await admin
      .from('task_requests')
      .select('id, last_external_activity_at, last_staff_viewed_at')
      .not('status', 'in', '("rejected","archived")')
    if (error || !data) return 0
    return data.filter(r =>
      r.last_external_activity_at &&
      (!r.last_staff_viewed_at || r.last_external_activity_at > r.last_staff_viewed_at)
    ).length
  } catch { return 0 }
}
