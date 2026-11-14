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
import { sendWebPush, type PushPayload } from '@/lib/push/send'

/** Longest a notification waits for the push services before moving on. */
const PUSH_WAIT_MS = 8000

/**
 * Sends the phone alerts and waits for them (bounded). On Vercel a function is frozen
 * as soon as its response is sent, so a push that is fired and not awaited is usually
 * never delivered. Never throws.
 */
async function pushAll(sends: readonly { employeeId: string; payload: PushPayload }[]): Promise<void> {
  if (!sends.length) return
  await Promise.race([
    Promise.all(sends.map(s => Promise.resolve(sendWebPush(s.employeeId, s.payload)).catch(() => {}))),
    new Promise(resolve => setTimeout(resolve, PUSH_WAIT_MS)),
  ])
}

export type NotificationType =
  | 'recurring_tasks_generated'
  | 'payroll_draft_created'
  | 'invoice_overdue'
  // Owner alerts (lib/owner-alerts)
  | 'invoice_overdue_stage'
  | 'invoice_unsent'
  | 'client_quiet'
  | 'owner_weekly_check'
  /** Something shared from WhatsApp was filed in the Requests inbox. */
  | 'whatsapp_request'
  | 'whatsapp_capture_failed'
  /** The gateway reported the spare number logged out / disconnected. */
  | 'whatsapp_listener_down'
  /** Listener switched on, but nothing has arrived for a day. */
  | 'whatsapp_listener_silent'
  /** Something in a client WhatsApp chat is waiting on Cirqle (lib/whatsapp-listener/insights). */
  | 'whatsapp_pending'
  | 'offer_sync_failed'
  | 'followup_escalated'
  // Recruitment module
  | 'application_received'
  | 'interview_scheduled'
  | 'interview_reminder'
  | 'candidate_selected'
  | 'offer_accepted'
  // Social Hub / Meta integration
  | 'meta_lead_received'
  | 'social_post_published'
  | 'social_post_failed'
  | 'social_sync_failed'
  | 'meta_reauth_required'
  /** A performance_alert_rules threshold breached (reach/leads drop, CPL, ROAS…). */
  | 'performance_alert'
  // Field Marketing
  | 'field_place_assigned'
  | 'field_followup_due'

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
    // Web push to the employee's devices (best-effort; no-op without VAPID/subs).
    // Skipped on duplicate (23505) so a cron re-run doesn't re-push.
    if (!error) {
      await pushAll([{ employeeId: input.employeeId, payload: {
        title: input.title,
        body: input.message ?? undefined,
        url: input.link ?? '/dashboard',
        tag: input.sourceKey ?? undefined,
      } }])
    }
  } catch (err) {
    console.warn('createNotification threw:', err)
  }
}

/** Notify every active admin employee — one independent row each. */
export async function notifyAdmins(input: NotificationContent): Promise<void> {
  try {
    const admin = createAdminClient()
    // Only an explicit admin designation receives administrative notifications.
    const { data: employees, error: empErr } = await admin
      .from('employees')
      .select('id, designation_id, designation:designation_id(is_admin)')
      .eq('is_active', true)
      .eq('is_archived', false)
    if (empErr || !employees) { console.warn('notifyAdmins: could not list employees:', empErr?.message); return }

    type EmployeeRow = { id: string; designation_id: string | null; designation: { is_admin: boolean } | { is_admin: boolean }[] | null }
    const adminIds = (employees as EmployeeRow[])
      .filter(e => (Array.isArray(e.designation) ? e.designation[0]?.is_admin : e.designation?.is_admin) === true)
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
    const insertedIds = error ? [] : [...adminIds]
    // Bulk insert: a single duplicate-key row aborts the whole batch under
    // default Postgres behavior, so on conflict fall back to per-row inserts
    // (each independently no-ops on its own duplicate).
    if (error) {
      if (error.code === '23505') {
        for (const row of rows) {
          const { error: rowErr } = await admin.from('notifications').insert(row)
          if (rowErr && rowErr.code !== '23505') console.warn('notifyAdmins row failed:', rowErr.message)
          if (!rowErr) insertedIds.push(row.employee_id)
        }
      } else {
        console.warn('notifyAdmins failed:', error.message)
      }
    }
    // Only newly inserted notifications may push. Retries must not re-alert
    // admins about records already delivered or failed writes.
    const payload = { title: input.title, body: input.message ?? undefined, url: input.link ?? '/dashboard', tag: input.sourceKey ?? undefined }
    await pushAll(insertedIds.map(employeeId => ({ employeeId, payload })))
  } catch (err) {
    console.warn('notifyAdmins threw:', err)
  }
}

/** Notify every active admin employee of MULTIPLE notifications (batched). */
export async function notifyAdminsBatch(inputs: NotificationContent[]): Promise<void> {
  if (!inputs.length) return
  try {
    const admin = createAdminClient()
    const { data: employees, error: empErr } = await admin
      .from('employees')
      .select('id, designation_id, designation:designation_id(is_admin)')
      .eq('is_active', true)
      .eq('is_archived', false)
    if (empErr || !employees) { console.warn('notifyAdminsBatch: could not list employees:', empErr?.message); return }

    type EmployeeRow = { id: string; designation_id: string | null; designation: { is_admin: boolean } | { is_admin: boolean }[] | null }
    const adminIds = (employees as EmployeeRow[])
      .filter(e => (Array.isArray(e.designation) ? e.designation[0]?.is_admin : e.designation?.is_admin) === true)
      .map(e => e.id)
    if (!adminIds.length) return

    const rows: any[] = []
    for (const input of inputs) {
      for (const employeeId of adminIds) {
        rows.push({
          employee_id: employeeId,
          type: input.type,
          title: input.title,
          message: input.message ?? null,
          link: input.link ?? null,
          source_key: input.sourceKey ?? null,
        })
      }
    }
    
    // Attempt bulk insert; ignores 23505 constraints via fallback.
    const { error } = await admin.from('notifications').insert(rows)
    const insertedRows: typeof rows = error ? [] : [...rows]
    if (error) {
      if (error.code === '23505') {
        for (const row of rows) {
          const { error: rowErr } = await admin.from('notifications').insert(row)
          if (rowErr && rowErr.code !== '23505') console.warn('notifyAdminsBatch row failed:', rowErr.message)
          if (!rowErr) insertedRows.push(row)
        }
      } else {
        console.warn('notifyAdminsBatch failed:', error.message)
      }
    }
    
    await pushAll(insertedRows.map(row => ({
      employeeId: row.employee_id,
      payload: { title: row.title, body: row.message ?? undefined, url: row.link ?? '/dashboard', tag: row.source_key ?? undefined },
    })))
  } catch (err) {
    console.warn('notifyAdminsBatch threw:', err)
  }
}
