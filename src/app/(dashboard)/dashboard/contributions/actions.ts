'use server'

import { syncTaskAgreementEarnings } from '@/lib/sync/agreement-earnings'
import { requireAnyPermission } from '@/lib/permissions/check'
import { logActivity } from '@/lib/activity/log'

/**
 * Apply employee commission agreements to a task's stored earnings after the
 * contributions client has saved the base contribution scores. No-op when there
 * are no active agreements (or pre-migration) — so nothing changes for tasks
 * whose contributors have no agreement.
 */
export async function applyTaskAgreements(taskId: string): Promise<{ ok: boolean; changed: number }> {
  try {
    const { changed } = await syncTaskAgreementEarnings(taskId)
    return { ok: true, changed }
  } catch {
    return { ok: false, changed: 0 }
  }
}

/**
 * Record a "Contribution saved" entry on the task's activity timeline.
 * Fire-and-forget from the contributions client after a successful save —
 * logged under entity_type='task' so it shares the unified per-task thread
 * with task creation/status/edits (visible in the Tasks modal Activity tab too).
 */
export async function logContributionSaved(
  taskId: string,
  detail?: { employees?: number; title?: string },
): Promise<void> {
  const guard = await requireAnyPermission(['contributions.edit', 'contributions.view_all'])
  if (!guard.ok) return
  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   taskId,
    action:     'contribution_saved',
    detail:     detail ?? null,
  })
}
