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
  // Wave A additions (docs/cirqle-connect/DATABASE_SCHEMA.md §1) — the DB CHECK
  // was dropped in migration 014; this union is now the source of truth.
  | 'client'
  | 'project'
  | 'file'
  | 'message'
  | 'approval'
  | 'kb_document'
  | 'auth'
  | 'setting'
  | 'leave'
  | 'quotation'
  // Recruitment module
  | 'job_application'
  | 'job_position'
  | 'interview'
  | 'offer'
  // Field Marketing — physical prospect on the territory map
  | 'field_place'

/** Timeline filter groups — mirrors migration 014 backfill mapping. */
export type ActivityCategory =
  | 'tasks' | 'billing' | 'chat' | 'files'
  | 'advertising' | 'crm' | 'employees' | 'finance'
  | 'recruitment'

/** Default category per entity type (writers may override, e.g. payroll expense vs advance). */
export const DEFAULT_CATEGORY: Record<EntityType, ActivityCategory> = {
  task: 'tasks', contribution: 'tasks', score: 'tasks',
  invoice: 'billing', quotation: 'billing',
  cashbook: 'finance', payroll: 'finance',
  employee: 'employees', auth: 'employees', leave: 'employees',
  client: 'crm', setting: 'crm', kb_document: 'crm', note: 'crm',
  project: 'advertising',
  file: 'files',
  message: 'chat', approval: 'crm',
  job_application: 'recruitment', job_position: 'recruitment',
  interview: 'recruitment', offer: 'recruitment',
  field_place: 'crm',
}

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
  // Recruitment
  | 'applied' | 'stage_changed' | 'note_added' | 'document_added'
  | 'interview_scheduled' | 'interview_completed' | 'interview_cancelled'
  | 'offer_sent' | 'offer_accepted' | 'offer_declined'
  | 'position_created' | 'position_closed'

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
  // ── Wave A: timeline category + scope (all optional, backward compatible) ──
  /** Filter group. Derived from entityType via DEFAULT_CATEGORY when omitted. */
  category?:   ActivityCategory
  /** Scope links so entity timelines are single index scans (migration 014). */
  clientId?:   string | null
  projectId?:  string | null
  taskId?:     string | null
  conversationId?: string | null
  /** Recruitment module scope — job_applications.id (migration 020). */
  applicationId?: string | null
}

/**
 * Write one log row. Always resolves — errors are console-warned, never thrown.
 * Callers should use `void logActivity(...)` to make the fire-and-forget intent
 * explicit in code review.
 */
export async function logActivity(input: LogActivityInput): Promise<void> {
  try {
    const admin = createAdminClient()
    const legacyRow = {
      actor_id:    input.actorId    ?? null,
      subject_id:  input.subjectId  ?? null,
      entity_type: input.entityType,
      entity_id:   input.entityId   ?? null,
      action:      input.action,
      detail:      input.detail     ?? null,
      note:        input.note       ?? null,
    }
    // Auto-derive scope from the entity itself so existing writers
    // (task/client/project actions) populate scope columns without changes.
    const autoScope = {
      client_id:  input.clientId  ?? (input.entityType === 'client'  ? input.entityId ?? null : null),
      project_id: input.projectId ?? (input.entityType === 'project' ? input.entityId ?? null : null),
      task_id:    input.taskId    ?? (input.entityType === 'task'    ? input.entityId ?? null : null),
      application_id: input.applicationId ?? (input.entityType === 'job_application' ? input.entityId ?? null : null),
    }
    const { error } = await admin.from('activity_logs').insert({
      ...legacyRow,
      category:        input.category ?? DEFAULT_CATEGORY[input.entityType] ?? 'crm',
      ...autoScope,
      conversation_id: input.conversationId ?? null,
    })
    if (error) {
      // PGRST204 = column not found → migration 014 not applied yet.
      // Fall back to the legacy shape so logging never silently stops.
      if ((error as { code?: string }).code === 'PGRST204') {
        const { error: legacyErr } = await admin.from('activity_logs').insert(legacyRow)
        if (legacyErr) console.warn('[activity_log] write failed (legacy fallback):', legacyErr.message)
      } else {
        console.warn('[activity_log] write failed:', error.message)
      }
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
