'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { loadCurrentUser } from '@/lib/permissions/check'

/**
 * Server-side employees import/export for the bulk data screen.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The import screen used to read and write `employees` straight from the
 * browser with the anon-key client:
 *
 *     supabase.from('employees').select('*')        // Export tab
 *     supabase.from('employees').insert(rows)       // Import tab
 *
 * Two problems, and the first is live today.
 *
 * 1. PRIVILEGE. /dashboard/import is gated on `tasks.create` — a permission
 *    most employees hold — so anyone who could create a task could export the
 *    entire employees table to a spreadsheet: base_salary, hourly_rate,
 *    bank_details, date_of_birth, the lot. The gate did not match the data.
 *
 * 2. IT BLOCKS LEAST PRIVILEGE. 20260830120000 narrows `authenticated` to
 *    eleven columns of `employees`. A column-level GRANT is role-level, so
 *    `select('*')` fails outright the moment any column is ungranted — for
 *    admins too. Re-gating alone would not have fixed that; the read had to
 *    move server-side regardless.
 *
 * So the employees mode now runs here, on the service role, behind permissions
 * that describe the data: `employees.view_full` to read whole rows,
 * `employees.create` / `employees.edit` to write them. Every other import mode
 * still goes direct from the browser — those tables keep their grants and hold
 * nothing comparable.
 *
 * Exports are audit-logged. Bulk-reading every colleague's salary is exactly
 * the kind of thing that should leave a trace.
 *
 * NOTE: this file is `'use server'`, so it may export async functions and
 * nothing else — no types, no constants. A single type export makes every
 * action in the module fail at runtime.
 */

interface Result<T = void> {
  ok: boolean
  error?: string
  data?: T
}

/** Whole employee rows, for the Export tab. Requires `employees.view_full`. */
export async function exportEmployeeRows(): Promise<Result<Record<string, unknown>[]>> {
  const auth = await requirePermission(PERMS.EMPLOYEES_VIEW_FULL)
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data, error } = await admin.from('employees').select('*').order('cqid', { ascending: true })
  if (error) return { ok: false, error: error.message }

  const me = await loadCurrentUser().catch(() => null)
  await logActivity({
    actorId: me?.employeeId ?? null,
    entityType: 'employee',
    action: 'exported',
    detail: { count: data?.length ?? 0, via: 'bulk import/export screen' },
  }).catch(() => {})

  return { ok: true, data: (data ?? []) as Record<string, unknown>[] }
}

/**
 * Whole employee rows by id, for the pre-update backup the Import tab writes
 * before it changes anything. Same data as an export, so the same permission.
 */
export async function fetchEmployeeRowsByIds(ids: string[]): Promise<Result<Record<string, unknown>[]>> {
  const auth = await requirePermission(PERMS.EMPLOYEES_VIEW_FULL)
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!ids.length) return { ok: true, data: [] }

  const admin = createAdminClient()
  const { data, error } = await admin.from('employees').select('*').in('id', ids)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: (data ?? []) as Record<string, unknown>[] }
}

/** Insert or upsert employee rows. Requires `employees.create`. */
export async function insertEmployeeRows(
  records: Record<string, unknown>[],
  conflict?: string,
): Promise<Result<{ inserted: number }>> {
  const auth = await requirePermission(PERMS.EMPLOYEES_CREATE)
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!records.length) return { ok: true, data: { inserted: 0 } }

  const admin = createAdminClient()
  const q = conflict
    ? admin.from('employees').upsert(records, { onConflict: conflict }).select('id')
    : admin.from('employees').insert(records).select('id')
  const { data, error } = await q
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { inserted: data?.length ?? 0 } }
}

/** Update employee rows by id. Requires `employees.edit`. */
export async function updateEmployeeRows(
  updates: { row_id: string; fields: Record<string, unknown> }[],
): Promise<Result<{ updated: number; errors: string[] }>> {
  const auth = await requirePermission(PERMS.EMPLOYEES_EDIT)
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!updates.length) return { ok: true, data: { updated: 0, errors: [] } }

  const admin = createAdminClient()
  const errors: string[] = []
  let updated = 0
  for (const { row_id, fields } of updates) {
    const { error } = await admin.from('employees').update(fields).eq('id', row_id)
    if (error) errors.push(`row ${row_id}: ${error.message}`)
    else updated += 1
  }
  return { ok: true, data: { updated, errors } }
}

/**
 * Hard-delete employee rows by id, for the bulk screen's delete operation.
 *
 * Gated on `employees.archive` — the permission that governs removing someone
 * from the workforce — because this is the most destructive thing the screen
 * can do and `employees.edit` is a much wider grant. The caller writes a CSV
 * backup of every row first (see backupBeforeUpdate in import-client).
 */
export async function deleteEmployeeRows(ids: string[]): Promise<Result<{ deleted: number }>> {
  const auth = await requirePermission(PERMS.EMPLOYEES_ARCHIVE)
  if (!auth.ok) return { ok: false, error: auth.error }
  if (!ids.length) return { ok: true, data: { deleted: 0 } }

  const admin = createAdminClient()
  const { error } = await admin.from('employees').delete().in('id', ids)
  if (error) return { ok: false, error: error.message }

  const me = await loadCurrentUser().catch(() => null)
  await logActivity({
    actorId: me?.employeeId ?? null,
    entityType: 'employee',
    action: 'deleted',
    detail: { count: ids.length, via: 'bulk import/export screen' },
  }).catch(() => {})

  return { ok: true, data: { deleted: ids.length } }
}
