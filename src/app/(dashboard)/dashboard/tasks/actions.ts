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
import { recalcTaskCommissions, syncDraftInvoices } from '@/lib/sync/integrity'
import { recalculatePayrollForMonth } from '@/app/(dashboard)/dashboard/payroll/actions'
import { syncRequestStatusFromTask, syncRequestStatusFromTasks } from '@/lib/requests/task-sync'

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

  // Mirror onto any promoted requests (no-op when none are linked).
  void syncRequestStatusFromTasks(ids, toStatus).catch(() => {})

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

  const { error: taskErr } = await admin.from('tasks').update({
    status:               'cancelled',
    cancelled_by:         input.cancelledBy,
    cancellation_notes:   input.notes || null,
    honor_contributions:  input.honorContributions,
    loss_amount:          input.lossAmount,
    completion_pct:       input.completionPct,
  }).eq('id', input.taskId)
  if (taskErr) return { ok: false, error: taskErr.message }

  if (!input.honorContributions) {
    await admin.from('contribution_scores').delete().eq('task_id', input.taskId)
  }

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

export async function serverFillTaskBilling(
  taskId:    string,
  clientId:  string | null,
  serviceId: string | null,
  quantity:  number,
): Promise<void> {
  if (!serviceId) return

  const admin = createAdminClient()

  const { data: svc } = await admin
    .from('services')
    .select('default_price, default_currency, pricing_type')
    .eq('id', serviceId)
    .maybeSingle()
  if (!svc) return

  // Resolve the UNIT price + currency. The per-client Pricing Matrix wins;
  // otherwise fall back to the service's default price. NOTE: matrix/default
  // price is *per creative / per unit* — quantity is applied below.
  let unitPrice: number | null = svc.default_price ?? null
  let unitCurrency = svc.default_currency || 'INR'
  if (clientId) {
    const { data: cp } = await admin
      .from('client_service_pricing')
      .select('price, currency')
      .eq('client_id', clientId)
      .eq('service_id', serviceId)
      .maybeSingle()
    if (cp?.price != null) { unitPrice = cp.price; unitCurrency = cp.currency || unitCurrency }
  }
  if (unitPrice == null || unitPrice <= 0) return

  // billing_amount is the TOTAL for the task. Per-unit & hourly pricing
  // multiply by quantity (the bug was a branch that stored the unit price as
  // the total — splitting it across units instead of multiplying). Retainer is
  // flat; percentage-of-spend can't be derived here so we leave billing alone.
  const pt = svc.pricing_type || 'fixed_per_creative'
  const qty = quantity || 1
  let amount: number
  if (pt === 'retainer') amount = unitPrice
  else if (pt === 'percentage_of_spend') return
  else amount = unitPrice * qty // fixed_per_creative, hourly, and sane default
  if (amount <= 0) return

  await admin.from('tasks').update({
    billing_amount:     amount,
    billing_amount_inr: await toInr(admin, amount, unitCurrency),
    currency:           unitCurrency,
  }).eq('id', taskId)

  // Cascade: keep contribution earnings, draft invoices, and pending payroll in
  // sync with the new billing — so a corrected price flows everywhere.
  await recalcTaskCommissions(taskId)
  await syncDraftInvoices(taskId)
  const { data: t } = await admin.from('tasks').select('task_date').eq('id', taskId).maybeSingle()
  if (t?.task_date) {
    const d = new Date(t.task_date)
    void recalculatePayrollForMonth({ month: d.getMonth() + 1, year: d.getFullYear(), source: 'task_edit' }).catch(() => {})
  }
}

// ── Inline task update (for table edits) ──────────────────────────────────────

export async function serverInlineTaskUpdate(
  taskId: string,
  updates: any,
  currencyForInrConversion?: string
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.TASKS_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()

  if (updates.billing_amount !== undefined && currencyForInrConversion) {
    updates.billing_amount_inr = await toInr(admin, updates.billing_amount, currencyForInrConversion)
  }

  const { error } = await admin.from('tasks').update(updates).eq('id', taskId)
  if (error) return { ok: false, error: error.message }

  // Sync Integrity!
  await syncDraftInvoices(taskId)
  await recalcTaskCommissions(taskId, guard.employeeId)
  if (updates.status) void syncRequestStatusFromTask(taskId, updates.status).catch(() => {})

  return { ok: true }
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
  billingAmount?: number
  billingAmountInr?: number
  quantity?:    number
  currency?:    string
  taskDate:     string | null
}

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

  // SYNC INTEGRITY!
  await syncDraftInvoices(input.taskId)
  await recalcTaskCommissions(input.taskId, guard.employeeId)
  if (input.status) void syncRequestStatusFromTask(input.taskId, input.status).catch(() => {})

  // Auto-recalculate pending payroll for this task's month
  if (input.taskDate) {
    const taskDate = new Date(input.taskDate)
    const month = taskDate.getMonth() + 1
    const year = taskDate.getFullYear()
    // Fire-and-forget; don't block task save if payroll recalc fails
    void recalculatePayrollForMonth({ month, year, source: 'task_edit' }).catch(() => {
      // Silently ignore payroll errors; task save succeeded
    })
  }

  return { ok: true, data }
}

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

/**
 * Record a team-assignment change on the task's activity timeline.
 * Called fire-and-forget from the client after assignments are saved.
 */
export async function logTaskAssignment(
  taskId: string,
  detail?: { employees?: string[]; title?: string },
): Promise<void> {
  const guard = await requirePermission(PERMS.TASKS_ASSIGN)
  if (!guard.ok) return

  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   taskId,
    action:     'assigned',
    detail:     detail ?? null,
  })
}
