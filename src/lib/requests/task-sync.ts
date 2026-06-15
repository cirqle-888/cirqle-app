import { createAdminClient } from '@/lib/supabase/admin'
import { requestStatusFromTask, projectClientStatus, logRequestActivity } from '@/lib/requests/core'
import { notifyRequesterStatus } from '@/lib/requests/notify'

/**
 * Mirror a promoted task's status onto its linked request (design §3) so the
 * client tracking page always shows the truth without double-updating.
 * Fully defensive: no linked request (or no portal tables) → silent no-op.
 * Never blocks the task save — callers fire-and-forget.
 */
export async function syncRequestStatusFromTask(taskId: string, taskStatus: string): Promise<void> {
  try {
    const mapped = requestStatusFromTask(taskStatus)
    if (!mapped) return

    const admin = createAdminClient()
    const { data: reqs, error } = await admin
      .from('task_requests')
      .select('id, ref_no, title, status, source, track_token, client_id, agency_id, submitter_email')
      .eq('promoted_task_id', taskId)
    if (error || !reqs || reqs.length === 0) return

    for (const req of reqs) {
      if (req.status === mapped) continue
      // Don't resurrect / reopen a closed request when an old task is touched.
      if (req.status === 'rejected' || req.status === 'archived' || req.status === 'cancelled') continue

      await admin.from('task_requests').update({
        status: mapped,
        client_status: projectClientStatus(mapped),
        status_updated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', req.id)

      await logRequestActivity(admin, {
        requestId: req.id,
        actorType: 'system',
        actorLabel: 'Cirqle',
        action: 'status_changed',
        visibility: req.source === 'agency' ? 'agency' : 'client',
        detail: { from: req.status, to: mapped, via: 'task_status' },
      })

      if (mapped === 'completed' || mapped === 'delivered') {
        void notifyRequesterStatus(req as any, mapped)
      }
    }
  } catch { /* portal not migrated / transient — never affect task saves */ }
}

/** Bulk variant for serverBulkUpdateStatus. */
export async function syncRequestStatusFromTasks(taskIds: string[], taskStatus: string): Promise<void> {
  for (const id of taskIds) await syncRequestStatusFromTask(id, taskStatus)
}
