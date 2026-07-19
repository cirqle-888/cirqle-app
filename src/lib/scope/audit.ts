/**
 * Service Scope — assignment audit trail (server-only).
 *
 * Append-only by construction: this module only ever INSERTs, and the table
 * carries a BEFORE UPDATE OR DELETE trigger that raises (RLS alone would not
 * stop the service-role client the whole app writes with).
 *
 * Why not activity_logs: it already records `services_assigned`, but as a
 * whole-set snapshot with no prior value and no per-pair action, buried in
 * JSONB — so it cannot answer "when did this employee lose that service".
 * Typed columns here make employee / client / service / date filtering a plain
 * indexed query. Follows the allocation_audit_log / cashbook_audit_log precedent.
 */

import type { createAdminClient } from '@/lib/supabase/admin'

type Admin = ReturnType<typeof createAdminClient>

export type ScopeAuditKind = 'employee_service' | 'client_service'
/** 'updated' = repriced without an active-state change (migration 20260720110000). */
export type ScopeAuditAction = 'added' | 'removed' | 'activated' | 'deactivated' | 'updated'
export type ScopeAuditSource = 'ui' | 'matrix' | 'import' | 'backfill' | 'api'

export interface ScopeAuditEntry {
  scopeKind: ScopeAuditKind
  action: ScopeAuditAction
  employeeId?: string | null
  clientId?: string | null
  serviceId?: string | null
  oldValue?: Record<string, unknown> | null
  newValue?: Record<string, unknown> | null
  actorId?: string | null
  source?: ScopeAuditSource
}

const payload = (entries: ScopeAuditEntry[]) => entries.map(e => ({
  scope_kind:  e.scopeKind,
  action:      e.action,
  employee_id: e.employeeId ?? null,
  client_id:   e.clientId ?? null,
  service_id:  e.serviceId ?? null,
  old_value:   e.oldValue ?? null,
  new_value:   e.newValue ?? null,
  actor_id:    e.actorId ?? null,
  source:      e.source ?? 'ui',
}))

/**
 * Record assignment changes. Never throws and never blocks the caller — a
 * failed audit write must not fail the assignment it describes (the table may
 * also not exist yet pre-migration).
 */
export async function logScopeChanges(
  admin: Admin,
  entries: ScopeAuditEntry[],
): Promise<{ written: number; error?: string }> {
  if (entries.length === 0) return { written: 0 }
  try {
    // supabase-js RESOLVES with { error } on a database failure — it does not
    // reject. A bare try/catch therefore never sees a constraint violation,
    // an RLS rejection or a missing table, and the audit row silently
    // disappears. (That is exactly how an unapplied CHECK migration made
    // every 'updated' entry vanish with no signal anywhere.) Inspect the
    // error explicitly, log it, and report it to the caller — while still
    // never throwing, because a failed audit must not fail the write it
    // describes.
    const { error } = await admin.from('service_scope_audit').insert(payload(entries))
    if (!error) return { written: entries.length }

    // The insert is ONE statement, so Postgres rolls back the whole array when
    // a single row violates the CHECK — e.g. an 'updated' action while
    // migration 20260720110000 is still unapplied would discard the legal
    // 'added' and 'activated' rows alongside it. Retry per row so one illegal
    // entry costs only itself.
    const rows = payload(entries)
    let written = 0
    const failures: string[] = []
    for (const row of rows) {
      const { error: rowError } = await admin.from('service_scope_audit').insert(row)
      if (rowError) failures.push(`${row.action}: ${rowError.message}`)
      else written++
    }
    if (failures.length === 0) return { written }

    const message = `${failures.length}/${rows.length} audit row(s) rejected — ${[...new Set(failures)].join('; ')}`
    console.error('[scope-audit]', message)
    return { written, error: message }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(`[scope-audit] ${entries.length} row(s) NOT recorded (transport):`, message)
    return { written: 0, error: message }
  }
}

/**
 * Diff two assignment sets into audit entries. Used by every bulk path
 * (employee form, service form, matrix, import) so they all produce identical,
 * per-pair records rather than each inventing its own shape.
 */
export function diffAssignments(opts: {
  scopeKind: ScopeAuditKind
  before: Iterable<string>
  after: Iterable<string>
  /** The fixed side of the pair (the employee, or the client). */
  anchor: { employeeId?: string | null; clientId?: string | null }
  /** True when the varying side is the service (the usual case). */
  actorId?: string | null
  source?: ScopeAuditSource
}): ScopeAuditEntry[] {
  const before = new Set(opts.before)
  const after = new Set(opts.after)
  const entries: ScopeAuditEntry[] = []

  for (const serviceId of after) {
    if (before.has(serviceId)) continue
    entries.push({
      scopeKind: opts.scopeKind, action: 'added', serviceId,
      employeeId: opts.anchor.employeeId ?? null, clientId: opts.anchor.clientId ?? null,
      oldValue: null, newValue: { assigned: true },
      actorId: opts.actorId ?? null, source: opts.source ?? 'ui',
    })
  }
  for (const serviceId of before) {
    if (after.has(serviceId)) continue
    entries.push({
      scopeKind: opts.scopeKind, action: 'removed', serviceId,
      employeeId: opts.anchor.employeeId ?? null, clientId: opts.anchor.clientId ?? null,
      oldValue: { assigned: true }, newValue: null,
      actorId: opts.actorId ?? null, source: opts.source ?? 'ui',
    })
  }
  return entries
}
