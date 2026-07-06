/**
 * Notification writer — fire-and-forget, mirrors src/lib/activity/log.ts.
 *
 * Reuses the `notifications` table from the original base schema (existed
 * since day one, was never wired to any code).
 *
 * `notifyAdmins()` fans a notification out as one row PER admin employee —
 * deliberately NOT a single shared employee_id=NULL row, because a shared
 * row would mean one admin marking it read hides it for every other admin.
 *
 * `sourceKey` is an idempotency key (e.g. `payroll_draft:2026-06`) — if a
 * cron re-runs for the same period, the unique index on
 * (type, source_key, employee_id) makes the repeat insert a silent no-op
 * per-admin instead of a duplicate.
 */

import { createAdminClient } from '@/lib/supabase/admin'

export type NotificationType =
  | 'recurring_tasks_generated'
  | 'payroll_draft_created'
  | 'invoice_overdue'
  | 'offer_sync_failed'
  | 'followup_escalated'
  // Recruitment module
  | 'application_received'
  | 'interview_scheduled'
  | 'interview_reminder'
  | 'candidate_selected'
  | 'offer_accepted'

interface NotificationContent {
  type: NotificationType | (string & {})
  title: string
  message?: string | null
  link?: string | null
  /** Idempotency key — pass for any cron-generated notification. */
  sourceKey?: string | null
}

/** Notify one specific employee. */
export async function createNotification(input: NotificationContent & { employeeId: string }): Promise<void> {
  try {
    const admin = createAdminClient()
    const { error } = await admin.from('notifications').insert({
      employee_id: input.employeeId,
      type: input.type,
      title: input.title,
      message: input.message ?? null,
      link: input.link ?? null,
      source_key: input.sourceKey ?? null,
    })
    // Unique-violation on (type, source_key, employee_id) = "already notified for this period" — expected.
    if (error && error.code !== '23505') {
      console.warn('createNotification failed:', error.message)
    }
  } catch (err) {
    console.warn('createNotification threw:', err)
  }
}

/** Notify every active admin employee — one independent row each. */
export async function notifyAdmins(input: NotificationContent): Promise<void> {
  try {
    const admin = createAdminClient()
    // Admin = designation.is_admin = true, OR no designation at all
    // (pre-migration fallback — mirrors the same rule in lib/permissions/check.ts).
    const { data: employees, error: empErr } = await admin
      .from('employees')
      .select('id, designation_id, designation:designation_id(is_admin)')
      .eq('is_active', true)
    if (empErr || !employees) { console.warn('notifyAdmins: could not list employees:', empErr?.message); return }

    type EmployeeRow = { id: string; designation_id: string | null; designation: { is_admin: boolean } | { is_admin: boolean }[] | null }
    const adminIds = (employees as EmployeeRow[])
      .filter(e => !e.designation_id || (Array.isArray(e.designation) ? e.designation[0]?.is_admin : e.designation?.is_admin) === true)
      .map(e => e.id)
    if (!adminIds.length) return

    const rows = adminIds.map(employeeId => ({
      employee_id: employeeId,
      type: input.type,
      title: input.title,
      message: input.message ?? null,
      link: input.link ?? null,
      source_key: input.sourceKey ?? null,
    }))
    const { error } = await admin.from('notifications').insert(rows)
    // Bulk insert: a single duplicate-key row aborts the whole batch under
    // default Postgres behavior, so on conflict fall back to per-row inserts
    // (each independently no-ops on its own duplicate).
    if (error) {
      if (error.code === '23505') {
        for (const row of rows) {
          const { error: rowErr } = await admin.from('notifications').insert(row)
          if (rowErr && rowErr.code !== '23505') console.warn('notifyAdmins row failed:', rowErr.message)
        }
      } else {
        console.warn('notifyAdmins failed:', error.message)
      }
    }
  } catch (err) {
    console.warn('notifyAdmins threw:', err)
  }
}
