'use server'

import { syncTaskAgreementEarnings } from '@/lib/sync/agreement-earnings'

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
