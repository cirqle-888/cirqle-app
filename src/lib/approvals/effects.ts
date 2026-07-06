/**
 * Approval effects — the ONE place entity-specific post-decision behavior
 * lives (docs/cirqle-connect/ARCHITECTURE.md §3.4). Each effect re-validates
 * entity state before acting and is best-effort: a failing effect never
 * blocks the decision itself.
 *
 * Add new entity behaviors here — nowhere else.
 */

import { createAdminClient } from '@/lib/supabase/admin'

export type ApprovalDecision = 'approved' | 'rejected' | 'changes_requested'

interface EffectContext {
  entityId: string | null
  decision: ApprovalDecision
  decidedBy: string
}

type Effect = (ctx: EffectContext) => Promise<void>

export const approvalEffects: Record<string, Effect> = {
  /**
   * Task completion sign-off: approving closes the task; a rejection or
   * change request pushes it back to in_progress. Only acts while the task
   * is still in a reviewable state — a task someone already moved on is
   * left alone.
   */
  task_completion: async ({ entityId, decision }) => {
    if (!entityId) return
    const admin = createAdminClient()
    const { data: task } = await admin
      .from('tasks').select('id, status').eq('id', entityId).maybeSingle()
    if (!task) return
    const reviewable = ['pending', 'in_progress', 'delivered'].includes(task.status)
    if (!reviewable) return
    const next = decision === 'approved' ? 'done' : 'in_progress'
    await admin.from('tasks')
      .update({ status: next })
      .eq('id', entityId)
      .eq('status', task.status) // optimistic: only if unchanged since read
  },

  /**
   * Invoice sign-off: approving a draft marks it ready to send (status stays
   * 'draft' — we set a metadata-style flag via notes? No: keep it minimal and
   * non-destructive. v1 records the decision only; the invoice UI shows the
   * approval badge from the approvals table itself.)
   */
  // invoice: intentionally no side effect in v1 — decision itself is the record.
}

/** Run the effect for an entity type, swallowing failures (never blocks the decision). */
export async function runApprovalEffect(
  entityType: string,
  ctx: EffectContext,
): Promise<void> {
  const effect = approvalEffects[entityType]
  if (!effect) return
  try {
    await effect(ctx)
  } catch (err) {
    console.warn(`[approvals] effect for '${entityType}' failed:`, err)
  }
}
