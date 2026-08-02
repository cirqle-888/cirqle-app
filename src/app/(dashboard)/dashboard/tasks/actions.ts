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
import { requirePermission } from '@/lib/permissions/check'
import { logActivity } from '@/lib/activity/log'
import { PERMS } from '@/lib/permissions/keys'
import { revalidatePath } from 'next/cache'
import { recalcTaskCommissions, syncDraftInvoices } from '@/lib/sync/integrity'
import { getTaskCoverage, getRetainerCoverageInfo, type RetainerCoverageInfo } from '@/lib/agreements/coverage'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { recalculatePayrollForMonth } from '@/app/(dashboard)/dashboard/payroll/actions'
import { syncRequestStatusFromTask, syncRequestStatusFromTasks } from '@/lib/requests/task-sync'
import { retryWithoutScope, withoutScope } from '@/lib/finance/classify'

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

  // Log BEFORE deleting and await it: written after, the row's auto-derived
  // task_id references a task that no longer exists and the insert dies on
  // activity_logs_task_id_fkey — the audit entry was silently lost. Written
  // first, the FK is valid, and the delete's ON DELETE SET NULL clears
  // task_id while entity_id + detail keep the historical record.
  await logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   taskId,
    action:     'deleted',
    detail:     { title: taskTitle, permanent: true },
  })

  const { error } = await admin.from('tasks').delete().eq('id', taskId)
  if (error) return { ok: false, error: error.message }

  return { ok: true }
}

export async function serverEmptyTrash(taskIds: string[]): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.TASKS_TRASH)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  if (taskIds.length === 0) return { ok: true }

  await logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   null,
    action:     'deleted',
    detail:     { bulk: true, permanent: true, count: taskIds.length },
  })

  const CHUNK = 100
  for (let i = 0; i < taskIds.length; i += CHUNK) {
    const chunk = taskIds.slice(i, i + CHUNK)
    const { error } = await admin.from('tasks').delete().in('id', chunk)
    if (error) return { ok: false, error: error.message }
  }

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

  // SYNC INTEGRITY!
  await syncDraftInvoices(taskId)

  // Mirror onto any promoted requests (no-op when none are linked).
  void syncRequestStatusFromTask(taskId, toStatus).catch(() => {})

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

  // SYNC INTEGRITY!
  for (const id of ids) {
    await syncDraftInvoices(id)
  }

  // Mirror onto any promoted requests (no-op when none are linked).
  void syncRequestStatusFromTasks(ids, toStatus).catch(() => {})

  return { ok: true }
}

// ── Bulk assign employees ───────────────────────────────────────────────────
// Lighter-weight than the full "Assign team" modal (which also sets up
// per-employee group/parameter contribution splits) — this just sets which
// employees are on each selected task via task_assignments. Replaces each
// task's existing assignee set with the chosen one (== "reassign").

export async function serverBulkAssignEmployees(
  taskIds:     string[],
  employeeIds: string[],
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.TASKS_ASSIGN)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!taskIds.length) return { ok: false, error: 'No tasks selected.' }

  const admin = createAdminClient()

  const { error: delErr } = await admin.from('task_assignments').delete().in('task_id', taskIds)
  if (delErr) return { ok: false, error: delErr.message }

  if (employeeIds.length > 0) {
    const rows = taskIds.flatMap(task_id => employeeIds.map(employee_id => ({ task_id, employee_id })))
    const { error: insErr } = await admin.from('task_assignments').insert(rows)
    if (insErr) return { ok: false, error: insErr.message }
  }

  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   null,
    action:     'assigned',
    detail:     { bulk: true, taskCount: taskIds.length, employeeIds },
  })

  return { ok: true }
}

// ── Bulk delete (soft) ──────────────────────────────────────────────────────

export async function serverBulkDeleteTasks(
  tasks: { id: string; title: string }[],
): Promise<ActionResult<{ deletedAt: string }>> {
  const guard = await requirePermission(PERMS.TASKS_DELETE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!tasks.length) return { ok: false, error: 'No tasks selected.' }

  const admin = createAdminClient()
  const deletedAt = new Date().toISOString()
  const ids = tasks.map(t => t.id)

  const CHUNK = 100
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const { error } = await admin.from('tasks').update({ deleted_at: deletedAt }).in('id', chunk)
    if (error) return { ok: false, error: error.message }
  }

  void logActivity({
    actorId:    guard.employeeId,
    entityType: 'task',
    entityId:   null,
    action:     'deleted',
    detail:     { bulk: true, count: tasks.length, titles: tasks.map(t => t.title).slice(0, 20) },
  })

  return { ok: true, data: { deletedAt } }
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
    // Written-off work is Cirqle's loss — company books. Deliberately NO
    // client_id: the auto_attach_expense_to_invoice trigger would rebill a
    // client-tagged outflow onto their draft invoice.
    const lossRow = {
      type:        'outflow',
      amount_inr:  input.lossAmount,
      entry_date:  input.taskDate,
      description: desc,
      scope:       'company' as const,
    }
    await retryWithoutScope(strip =>
      admin.from('cashbook_entries').insert(strip ? withoutScope(lossRow) : lossRow)
    )
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

  // Mirror onto any promoted requests (no-op when none are linked).
  void syncRequestStatusFromTask(input.taskId, 'cancelled').catch(() => {})

  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * Live retainer-coverage lookup for the task modal. Returns the card figures
 * when the client+service+date is covered by an active retainer, else null.
 * Money fields are nulled for viewers without agreements.view_pricing.
 */
export async function fetchRetainerCoverage(
  clientId: string | null,
  serviceId: string | null,
  taskDate: string | null,
): Promise<RetainerCoverageInfo | null> {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const pricingVisible = isAdmin || hasPermission(me, PERMS.AGREEMENTS_VIEW_PRICING)
  const admin = createAdminClient()
  return getRetainerCoverageInfo(admin, { clientId, serviceId, taskDate, pricingVisible })
}

export async function serverFillTaskBilling(
  taskId:    string,
  clientId:  string | null,
  serviceId: string | null,
  quantity:  number,
): Promise<void> {
  if (!serviceId) return

  const admin = createAdminClient()

  // Retainer-covered tasks carry NO client amount — the monthly retainer is the
  // charge. Zero any auto-filled amount and let the invoice sync strip any line.
  const coverage = await getTaskCoverage(admin, taskId)
  if (coverage.covered) {
    await admin.from('tasks').update({ billing_amount: 0, billing_amount_inr: 0 }).eq('id', taskId)
    await recalcTaskCommissions(taskId)
    await syncDraftInvoices(taskId)
    return
  }

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

  const inlineConflict = await coverageBillingConflict(admin, taskId, updates.billing_amount)
  if (inlineConflict) return { ok: false, error: inlineConflict }

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

/**
 * Refuses a non-zero billing amount on a retainer-covered task that is not
 * flagged as extra work.
 *
 * The coverage engine zeroes billing on covered tasks so the client is not
 * charged twice — once in the retainer fee, once per task. Nothing stopped a
 * manual edit from writing an amount straight back over that, which is how task
 * #1883 (Elara) came to bill AED 20 on top of a AED 400 retainer.
 *
 * We reject rather than auto-correct: silently zeroing loses the user's intent,
 * and silently setting bill_as_extra would start charging a client without
 * anyone deciding to. Returns null when the write is allowed.
 */
async function coverageBillingConflict(
  admin: ReturnType<typeof createAdminClient>,
  taskId: string,
  billingAmount: number | undefined,
): Promise<string | null> {
  if (billingAmount === undefined || billingAmount <= 0) return null

  const { data: task } = await admin
    .from('tasks')
    .select('retainer_item_id, bill_as_extra')
    .eq('id', taskId)
    .maybeSingle()

  if (!task?.retainer_item_id) return null   // not covered — bill freely
  if (task.bill_as_extra) return null        // explicitly extra work — bill freely

  return 'This task is covered by the client’s retainer, so it bills at 0. ' +
         'To charge for it on top of the retainer, tick “Bill as extra” first.'
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

  const conflict = await coverageBillingConflict(admin, input.taskId, input.billingAmount)
  if (conflict) return { ok: false, error: conflict }

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
 * Possible-duplicate check for the Add Task form: is there already a task
 * with this exact title for this client (or, for internal work, another
 * internal task), created within the last `windowHours`? Surfaced as a
 * non-blocking warning so two people creating the same task without knowing
 * about each other — whether a minute apart or later the same day — notice
 * before duplicating work.
 *
 * Server-side because activity_logs has no browser-readable RLS policy
 * (service-role-only) — the actor of the original "created" event can only
 * be resolved here. Returns the actor's employee id only; the caller
 * resolves display name locally so the live reveal-names toggle is honoured.
 */
export async function checkPossibleDuplicateTask(
  title: string,
  clientId: string | null,
  windowHours = 24,
): Promise<ActionResult<{ taskNumber: number | null; createdByEmployeeId: string | null; minutesAgo: number } | null>> {
  const guard = await requirePermission(PERMS.TASKS_CREATE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const trimmed = title.trim()
  if (trimmed.length < 3) return { ok: true, data: null }

  const admin = createAdminClient()
  const cutoff = new Date(Date.now() - windowHours * 60 * 60_000).toISOString()

  let q = admin
    .from('tasks')
    .select('id, task_number, created_at')
    .ilike('title', trimmed)
    .is('deleted_at', null)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(1)
  q = clientId ? q.eq('client_id', clientId) : q.is('client_id', null)
  const { data: task } = await q.maybeSingle()
  if (!task) return { ok: true, data: null }

  const { data: log } = await admin
    .from('activity_logs')
    .select('actor_id')
    .eq('entity_type', 'task')
    .eq('entity_id', task.id)
    .eq('action', 'created')
    .maybeSingle()

  return {
    ok: true,
    data: {
      taskNumber: task.task_number ?? null,
      createdByEmployeeId: log?.actor_id ?? null,
      minutesAgo: Math.max(0, Math.round((Date.now() - new Date(task.created_at).getTime()) / 60_000)),
    },
  }
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
