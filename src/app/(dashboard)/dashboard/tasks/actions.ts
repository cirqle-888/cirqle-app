'use server'

/**
 * Task server actions — wraps the key task lifecycle mutations so they
 * are logged to activity_logs as a side-effect.
 *
 * Strategy:
 *  • Simple state changes (delete, restore, status) live entirely here —
 *    the browser client calls the server action instead of Supabase directly.
 *  • Task create is kept browser-side (complex billing math) but calls
 *    logTaskEvent() afterwards for the log row.
 *
 * All functions follow the same shape as other actions in this codebase:
 *   requirePermission → guard → DB mutation → logActivity (void) → return
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/auth/enforce'
import { logActivity } from '@/lib/activity/log'
import { PERMS } from '@/lib/permissions/keys'
import { revalidatePath } from 'next/cache'

const REVALIDATE = '/dashboard/tasks'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

// ── Soft delete (move to Trash) ───────────────────────────────────────────────

export async function serverDeleteTask(
  taskId: string,
  taskTitle: string,
): Promise<ActionResult<{ deleted_at: string }>> {
  const guard = await requirePermission(PERMS.TASKS_DELETE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin   = createAdminClient()
  const deletedAt = new Date().toISOString()

  const { error } = await admin
    .from('tasks')
    .update({ deleted_at: deletedAt })
    .eq('id', taskId)
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   taskId,
    action:     'deleted',
    detail:     { title: taskTitle },
  })

  return { ok: true, data: { deleted_at: deletedAt } }
}

// ── Restore from Trash ────────────────────────────────────────────────────────

export async function serverRestoreTask(
  taskId: string,
  taskTitle: string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.TASKS_TRASH)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('tasks')
    .update({ deleted_at: null })
    .eq('id', taskId)
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   taskId,
    action:     'restored',
    detail:     { title: taskTitle },
  })

  return { ok: true }
}

// ── Permanent delete ──────────────────────────────────────────────────────────

export async function serverPermanentDeleteTask(
  taskId: string,
  taskTitle: string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.TASKS_TRASH)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin.from('tasks').delete().eq('id', taskId)
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   taskId,
    action:     'deleted',
    detail:     { title: taskTitle, permanent: true },
  })

  return { ok: true }
}

// ── Status change ─────────────────────────────────────────────────────────────

export async function serverUpdateTaskStatus(
  taskId: string,
  taskTitle: string,
  fromStatus: string,
  toStatus:   string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.TASKS_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('tasks')
    .update({ status: toStatus })
    .eq('id', taskId)
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   taskId,
    action:     'status_changed',
    detail:     { title: taskTitle, from: fromStatus, to: toStatus },
  })

  return { ok: true }
}

// ── Bulk status change ────────────────────────────────────────────────────────

export async function serverBulkUpdateStatus(
  ids:      string[],
  toStatus: string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.TASKS_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  if (!ids.length) return { ok: false, error: 'No tasks selected.' }

  const admin = createAdminClient()
  // Batch in chunks of 100 to stay under Supabase IN() limit
  const CHUNK = 100
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const { error } = await admin
      .from('tasks')
      .update({ status: toStatus })
      .in('id', chunk)
    if (error) return { ok: false, error: error.message }
  }

  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   null,
    action:     'status_changed',
    detail:     { bulk: true, count: ids.length, to: toStatus },
  })

  return { ok: true }
}

// ── Cancel task ───────────────────────────────────────────────────────────────

export interface CancelTaskInput {
  taskId:              string
  taskTitle:           string
  cancelledBy:         string
  notes:               string | null
  honorContributions:  boolean
  lossAmount:          number
  completionPct:       number
  recordCashbook:      boolean
  taskDate:            string
  clientName:          string | null
}

export async function serverCancelTask(
  input: CancelTaskInput,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.TASKS_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()

  // 1. Update task
  const { error: taskErr } = await admin.from('tasks').update({
    status:               'cancelled',
    cancelled_by:         input.cancelledBy,
    cancellation_notes:   input.notes || null,
    honor_contributions:  input.honorContributions,
    loss_amount:          input.lossAmount,
    completion_pct:       input.completionPct,
  }).eq('id', input.taskId)
  if (taskErr) return { ok: false, error: taskErr.message }

  // 2. Remove contribution scores if not honouring
  if (!input.honorContributions) {
    await admin.from('contribution_scores').delete().eq('task_id', input.taskId)
  }

  // 3. Optionally record cashbook loss
  if (input.recordCashbook && input.lossAmount > 0) {
    const who = input.cancelledBy === 'client' ? 'Client cancellation'
      : input.cancelledBy === 'no_show' ? 'No-show' : 'Company decision'
    const desc = `[JOB LOSS] ${input.taskTitle}`
      + (input.clientName ? ` — ${input.clientName}` : '')
      + ` (${input.completionPct}% done, ${who})`
      + (input.notes ? ` — ${input.notes}` : '')
    await admin.from('cashbook_entries').insert({
      type:        'outflow',
      amount_inr:  input.lossAmount,
      entry_date:  input.taskDate,
      description: desc,
    })
  }

  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   input.taskId,
    action:     'status_changed',
    detail:     {
      title:         input.taskTitle,
      from:          'active',
      to:            'cancelled',
      cancelled_by:  input.cancelledBy,
      loss_amount:   input.lossAmount,
    },
  })

  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ── Backfill billing amount for tasks created by employees ───────────────────
//
// Employees don't receive pricing data, so their browser inserts billing_amount=0.
// This action runs server-side immediately after the browser insert; it looks up
// client-specific pricing (or the service default) via the admin client and
// updates billing_amount / billing_amount_inr without ever sending the price
// to the employee's browser.

export async function serverFillTaskBilling(
  taskId:    string,
  clientId:  string | null,
  serviceId: string | null,
  quantity:  number,
): Promise<void> {
  // No permission guard needed — this is a self-healing write, always safe.
  // It only updates tasks created seconds ago (the caller passes the new task id).
  if (!serviceId) return

  const admin = createAdminClient()

  // 1. Fetch service pricing info
  const { data: svc } = await admin
    .from('services')
    .select('default_price, default_currency, pricing_type')
    .eq('id', serviceId)
    .maybeSingle()

  if (!svc || !svc.default_price) {
    // Try client-specific override
    if (!clientId) return
    const { data: cp } = await admin
      .from('client_service_pricing')
      .select('price, currency')
      .eq('client_id', clientId)
      .eq('service_id', serviceId)
      .maybeSingle()
    if (!cp?.price) return

    const cpCurrency = cp.currency || 'INR'
    await admin.from('tasks').update({
      billing_amount:     cp.price,
      billing_amount_inr: await toInr(admin, cp.price, cpCurrency),
      currency:           cpCurrency,
    }).eq('id', taskId)
    return
  }

  // 2. Check for client-specific override price
  let unitPrice  = svc.default_price
  let unitCurrency = svc.default_currency || 'INR'
  if (clientId) {
    const { data: cp } = await admin
      .from('client_service_pricing')
      .select('price, currency')
      .eq('client_id', clientId)
      .eq('service_id', serviceId)
      .maybeSingle()
    if (cp?.price) { unitPrice = cp.price; unitCurrency = cp.currency || unitCurrency }
  }

  // 3. Compute amount based on pricing type
  const pt = svc.pricing_type || 'fixed_per_creative'
  const amount =
    pt === 'fixed_per_creative' ? unitPrice * (quantity || 1) :
    pt === 'retainer'           ? unitPrice :
    pt === 'hourly'             ? unitPrice * (quantity || 1) :
    0 // percentage_of_spend: can't compute without spend amount

  if (amount <= 0) return

  await admin.from('tasks').update({
    billing_amount:     amount,
    billing_amount_inr: await toInr(admin, amount, unitCurrency),
    currency:           unitCurrency,
  }).eq('id', taskId)
}

// ── Full task update (replaces browser-client update in TaskEditModal) ───────

export interface SaveTaskInput {
  taskId:       string
  taskNumber?:  number | null
  title:        string
  description:  string | null
  clientId:     string | null
  serviceId:    string | null
  status:       string
  // Optional: when omitted (e.g. editing a variant task), the existing billing
  // columns are left untouched so a derived/frozen price is never overwritten.
  billingAmount?: number
  billingAmountInr?: number
  quantity?:    number
  currency?:    string
  taskDate:     string | null
}

/**
 * Convert a billing amount in `currency` to INR using the current stored
 * exchange rate (exchange_rates.rate_to_inr). Falls back to 1:1 when the
 * currency is INR or no rate is configured — never worse than the old
 * behaviour, which stored the raw foreign number as if it were INR.
 */
async function toInr(
  admin: ReturnType<typeof createAdminClient>,
  amount: number,
  currency: string | null | undefined,
): Promise<number> {
  if (!currency || currency === 'INR') return amount
  const { data } = await admin
    .from('exchange_rates')
    .select('rate_to_inr')
    .eq('currency', currency)
    .maybeSingle()
  const rate = data?.rate_to_inr ?? 1
  return Math.round(amount * rate * 100) / 100
}

export async function serverSaveTask(
  input: SaveTaskInput,
): Promise<ActionResult<any>> {
  const guard = await requirePermission(PERMS.TASKS_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()

  // Derive the INR value server-side from the foreign amount + current rate, so
  // foreign-currency tasks store a true INR figure rather than the raw foreign
  // number the client passes. Variant edits omit billingAmount, leaving the
  // frozen parent-derived price untouched.
  const billingInr = input.billingAmount !== undefined
    ? await toInr(admin, input.billingAmount, input.currency)
    : undefined

  const { data, error } = await admin
    .from('tasks')
    .update({
      ...(input.taskNumber != null ? { task_number: input.taskNumber } : {}),
      title:              input.title,
      description:        input.description,
      client_id:          input.clientId || null,
      service_id:         input.serviceId || null,
      status:             input.status,
      // Only overwrite billing when the caller supplied it. Variant edits omit
      // these so the parent-derived price stays frozen.
      ...(input.billingAmount !== undefined ? { billing_amount: input.billingAmount } : {}),
      ...(billingInr !== undefined ? { billing_amount_inr: billingInr } : {}),
      ...(input.quantity         !== undefined ? { quantity:           input.quantity } : {}),
      ...(input.currency         !== undefined ? { currency:           input.currency } : {}),
      task_date:          input.taskDate || null,
    })
    .eq('id', input.taskId)
    .select('*, client:clients(id, name, code), service:services(id, name)')
    .single()

  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   input.taskId,
    action:     'updated',
    detail:     { title: input.title },
  })

  return { ok: true, data }
}

// ── Log task created (called from browser after insert) ───────────────────────
// Task create has complex billing math done browser-side, so the DB insert
// stays there. This lightweight action just writes the log row.

export async function logTaskCreated(
  taskId:    string,
  taskTitle: string,
  taskNumber: number | null,
): Promise<void> {
  const guard = await requirePermission(PERMS.TASKS_CREATE)
  if (!guard.ok) return

  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   taskId,
    action:     'created',
    detail:     { title: taskTitle, task_number: taskNumber },
  })
}
