/**
 * Activity log helper — fire-and-forget, never throws.
 *
 * Usage in any server action:
 *   void logActivity({ actorId, entityType: 'task', entityId, action: 'created' })
 *
 * The `void` prefix tells TypeScript (and the caller) that the Promise
 * result is intentionally discarded. The main action returns immediately;
 * the log write happens in the background and a failure only prints a
 * warning — it never breaks the user-facing operation.
 *
 * Performance:
 *   - One async INSERT per logged action — ~1–5 ms round-trip on Supabase
 *   - Never awaited on the hot path, so latency budget = zero
 *   - All three query-shape indexes are set in migration 010
 */

import { createAdminClient } from '@/lib/supabase/admin'

export type EntityType =
  | 'task'
  | 'contribution'
  | 'employee'
  | 'payroll'
  | 'invoice'
  | 'cashbook'
  | 'score'
  | 'note'

export type ActivityAction =
  // Tasks
  | 'created' | 'edited' | 'deleted' | 'restored' | 'status_changed' | 'assigned'
  // Contributions / scores
  | 'contribution_saved' | 'scored' | 'score_recalculated'
  // Payroll
  | 'payroll_generated' | 'marked_paid' | 'advance_added' | 'credit_added'
  // People
  | 'employee_created' | 'employee_archived' | 'designation_changed'
  // Manual
  | 'note'

export interface LogActivityInput {
  /** The employee who performed the action (omit for system jobs) */
  actorId?:    string | null
  /** The employee this log entry is primarily about (for profile timelines) */
  subjectId?:  string | null
  entityType:  EntityType
  /** The UUID (or other ID) of the affected row */
  entityId?:   string | null
  action:      ActivityAction | string   // string allows future actions without a type change
  /** Structured diff or context — e.g. [{ field, from, to }] */
  detail?:     Record<string, unknown> | unknown[] | null
  /** Free-text note for manual 'note' actions */
  note?:       string | null
}

/**
 * Write one log row. Always resolves — errors are console-warned, never thrown.
 * Callers should use `void logActivity(...)` to make the fire-and-forget intent
 * explicit in code review.
 */
export async function logActivity(input: LogActivityInput): Promise<void> {
  try {
    const admin = createAdminClient()
    const { error } = await admin.from('activity_logs').insert({
      actor_id:    input.actorId    ?? null,
      subject_id:  input.subjectId  ?? null,
      entity_type: input.entityType,
      entity_id:   input.entityId   ?? null,
      action:      input.action,
      detail:      input.detail     ?? null,
      note:        input.note       ?? null,
    })
    if (error) {
      console.warn('[activity_log] write failed:', error.message)
    }
  } catch (err) {
    // Never propagate — log failures must be invisible to users
    console.warn('[activity_log] unexpected error:', err)
  }
}

/**
 * Log a simple field diff between two objects.
 * Returns a detail array: [{ field, from, to }] for changed fields only.
 *
 * Usage:
 *   const detail = diffDetail(oldTask, newTask, ['status', 'title'])
 *   void logActivity({ ..., detail })
 */
export function diffDetail(
  before: Record<string, unknown>,
  after:  Record<string, unknown>,
  fields: string[],
): Array<{ field: string; from: unknown; to: unknown }> {
  return fields
    .filter(f => before[f] !== after[f])
    .map(f => ({ field: f, from: before[f] ?? null, to: after[f] ?? null }))
}
