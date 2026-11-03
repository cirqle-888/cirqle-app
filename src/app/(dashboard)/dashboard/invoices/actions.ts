'use server'

/**
 * Invoice server actions — write operations that need server-side access.
 *
 * recordInvoicePayment: records a payment AND auto-creates a matching cashbook
 * inflow entry so the payment appears immediately on the Cashbook page.
 */

import { revalidatePath } from 'next/cache'
import { loadCurrentUser, requireAnyPermission, requirePermission, requireReadPermission } from '@/lib/permissions/check'
import { financialVisibility, stripInvoiceList } from '@/lib/permissions/strip'
import { PERMS, RECORD_PAYMENT_PERMS } from '@/lib/permissions/keys'
import { recordPayment } from '@/lib/finance/record-payment'
import type { RecordInvoicePaymentInput } from '@/lib/finance/record-payment'
import { createAdminClient } from '@/lib/supabase/admin'
import { syncDraftInvoices, syncDraftInvoiceExpenses } from '@/lib/sync/integrity'
import { syncInvoicePackageLines } from '@/lib/packages/sync-invoice'
import { round2 as r2 } from '@/lib/calculations/currency'
import type { MissedTask } from '@/lib/invoices/missed-tasks'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

/**
 * A `'use server'` module may only EXPORT async functions. A re-export such as
 * `export type { RecordInvoicePaymentInput }` survives the server-actions
 * transform as a value reference, so the whole module blew up at evaluation
 * with `ReferenceError: RecordInvoicePaymentInput is not defined` — every
 * recordInvoicePayment() call 500'd and the Record Payment button hung.
 * Types belong in the module that defines them: import
 * `RecordInvoicePaymentInput` from '@/lib/finance/record-payment' directly.
 *
 * `employeeId` is deliberately NOT part of the caller's input: it is resolved
 * from the session so a client cannot attribute a payment to someone else.
 */
type RecordInvoicePaymentArgs = Omit<RecordInvoicePaymentInput, 'employeeId'>

export async function recordInvoicePayment(
  input: RecordInvoicePaymentArgs,
): Promise<ActionResult<{ paymentId: string; cashbookEntryId: string | null; receiptNumber: string | null }>> {
  const guard = await requireAnyPermission(RECORD_PAYMENT_PERMS)
  if (!guard.ok) return { ok: false, error: guard.error }

  // A throw here (missing service-role key, DB connection error) would reject on
  // the client as an opaque server-action failure and leave the Record Payment
  // button stuck on "Saving…". Convert it into a readable ActionResult instead.
  let result
  try {
    result = await recordPayment({ ...input, employeeId: guard.employeeId ?? null })
  } catch (err) {
    console.error('[recordInvoicePayment] threw:', err)
    return { ok: false, error: err instanceof Error ? err.message : 'Payment could not be recorded' }
  }
  if (!result.ok) {
    return { ok: false, error: result.error }
  }

  revalidatePath('/dashboard/invoices')
  revalidatePath('/dashboard/cashbook')

  return result
}

export async function serverResyncInvoiceTasks(
  invoiceId: string,
): Promise<ActionResult<{ syncedTasks: number; feeLines: number }>> {
  const guard = await requirePermission(PERMS.BILLING_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  
  const { data: inv } = await admin.from('invoices')
    .select('client_id, billing_period_start, billing_period_end, status')
    .eq('id', invoiceId).single()
    
  if (!inv) return { ok: false, error: 'Invoice not found' }
  if (inv.status !== 'draft') return { ok: false, error: 'Only draft invoices can be resynced' }
  if (!inv.billing_period_start || !inv.billing_period_end) return { ok: false, error: 'Invoice is missing billing period dates' }

  const { data: items } = await admin.from('invoice_items')
    .select('task_id')
    .eq('invoice_id', invoiceId)
    .not('task_id', 'is', null)
    
  const currentTaskIds = (items || []).map(i => i.task_id as string)

  const { data: periodTasks } = await admin.from('tasks')
    .select('id')
    .eq('client_id', inv.client_id)
    .gte('task_date', inv.billing_period_start)
    .lte('task_date', inv.billing_period_end)
    
  const possibleTaskIds = (periodTasks || []).map(t => t.id)
  
  const allIds = Array.from(new Set([...currentTaskIds, ...possibleTaskIds]))
  
  for (const tid of allIds) {
    await syncDraftInvoices(tid)
  }

  // Also sync expenses for the period
  const { data: expItems } = await admin.from('invoice_expense_items')
    .select('cashbook_entry_id')
    .eq('invoice_id', invoiceId)
    .not('cashbook_entry_id', 'is', null)
    
  const currentExpIds = (expItems || []).map(i => i.cashbook_entry_id as string)
  
  const { data: periodExps } = await admin.from('cashbook_entries')
    .select('id')
    .eq('client_id', inv.client_id)
    .eq('type', 'outflow')
    .is('deleted_at', null)
    .gte('entry_date', inv.billing_period_start)
    .lte('entry_date', inv.billing_period_end)
    
  const possibleExpIds = (periodExps || []).map(e => e.id)
  
  const allExpIds = Array.from(new Set([...currentExpIds, ...possibleExpIds]))
  
  for (const eid of allExpIds) {
    await syncDraftInvoiceExpenses(eid)
  }

  // Packages LAST, deliberately. The per-task sync above re-adds a line for
  // every done task, including ones a package covers; this then collapses those
  // back into the single fee line. Running it earlier would have the task sync
  // undo it.
  let feeLines = 0
  try {
    const pkg = await syncInvoicePackageLines(admin, invoiceId)
    feeLines = pkg.feeLines
  } catch { /* best-effort: never fail a resync over package lines */ }

  revalidatePath('/dashboard/invoices')
  return { ok: true, data: { syncedTasks: allIds.length + allExpIds.length, feeLines } }
}

/**
 * Line items and cashbook allocations for specific invoices, on demand.
 *
 * These two joins are ~80% of the invoices page payload (988 KB of 1375 KB for
 * 270 invoices, measured) and are only ever read for one invoice at a time —
 * the detail panel, the PDF, a statement, or a bulk action that has to walk the
 * covered tasks. The page therefore ships neither, and every reader pulls what
 * it needs through here.
 *
 * Deliberately a SERVER action rather than a browser query. `invoice_items`
 * carries `unit_price`, which `stripInvoiceAmounts` removes for a user without
 * `billing.view_line_pricing`; RLS is `authenticated USING(true)`, so a
 * client-side fetch of the same rows would hand that user the pricing the page
 * took care to withhold. Loading it here keeps the strip on the only path that
 * can enforce it.
 */
export async function getInvoiceDetails(
  invoiceIds: string[],
): Promise<ActionResult<Record<string, unknown>[]>> {
  const guard = await requireReadPermission(PERMS.BILLING_VIEW_INVOICES)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!invoiceIds.length) return { ok: true, data: [] }

  const me = await loadCurrentUser().catch(() => null)
  const vis = financialVisibility(me)

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('invoices')
    .select(`id,
      items:invoice_items(*, task:tasks(id, title, task_date, status, billing_amount_inr, currency, service:services!service_id(id, name)), service:services(id, name)),
      cashbook_invoice_allocations(id, deleted_at, allocated_amount, cashbook_entry:cashbook_entries!cashbook_entry_id(id, reference, entry_date, description, receipt_number, bank_account:bank_accounts(name)))
    `)
    .in('id', invoiceIds)

  if (error) return { ok: false, error: error.message }

  // Same strip the page applies to its own payload — see stripInvoiceList.
  const stripped = stripInvoiceList(
    (data || []) as Record<string, unknown>[],
    { amounts: vis.billingAmounts, linePricing: vis.billingLinePricing },
  )
  return { ok: true, data: stripped }
}

// ── Missed tasks ─────────────────────────────────────────────────────────────
//
// The automatic sync only ever adds a finished task to its own month's DRAFT.
// A task finished late — after that month's invoice went out — or one whose
// month had no draft at all is therefore never billed anywhere, and the only
// remedy used to be deleting the invoice and regenerating it. These two
// actions find such tasks for an invoice's client and add them to it.

/** Statuses an invoice can still take new lines in. Sent ones need a reason. */
const ADD_LINES_OPEN = ['draft', 'reviewed'] as const
const ADD_LINES_WITH_REASON = ['sent', 'partial', 'overdue'] as const

/** How far back to look for unbilled work, counted from the invoice's period end. */
const MISSED_LOOKBACK_MONTHS = 12

/**
 * Done, billable tasks for this invoice's client, dated up to the end of its
 * billing period, that are not on any live (non-cancelled) invoice.
 *
 * Tasks a package fee covers have no line of their own by design, so a task
 * tagged to a package is never "missed" — an over-allowance extra gets its own
 * repriced line from the package sync, which this check then sees as billed.
 * The caller also drops tasks the agreement breakdowns list as covered.
 */
export async function findMissedTasks(
  invoiceId: string,
): Promise<ActionResult<MissedTask[]>> {
  const guard = await requireReadPermission(PERMS.BILLING_VIEW_INVOICES)
  if (!guard.ok) return { ok: false, error: guard.error }

  const me = await loadCurrentUser().catch(() => null)
  const vis = financialVisibility(me)
  const admin = createAdminClient()

  const { data: inv } = await admin.from('invoices')
    .select('client_id, billing_period_end, issue_date')
    .eq('id', invoiceId).maybeSingle()
  if (!inv?.client_id) return { ok: false, error: 'Invoice not found' }

  const until = String(inv.billing_period_end || inv.issue_date || new Date().toISOString()).slice(0, 10)
  const since = new Date(`${until}T00:00:00Z`)
  since.setUTCMonth(since.getUTCMonth() - MISSED_LOOKBACK_MONTHS)

  const { data: tasks, error } = await admin.from('tasks')
    .select('id, title, task_date, status, quantity, currency, billing_amount, billing_amount_inr, service:services!service_id(name)')
    .eq('client_id', inv.client_id)
    .is('deleted_at', null)
    .not('is_billable', 'is', false)
    .is('package_id', null)
    .in('status', ['done', 'invoiced'])
    .gte('task_date', since.toISOString().slice(0, 10))
    .lte('task_date', until)
    .order('task_date')
  if (error) return { ok: false, error: error.message }
  if (!tasks?.length) return { ok: true, data: [] }

  const billed = await tasksOnLiveInvoices(admin, tasks.map(t => t.id))
  const missed: MissedTask[] = tasks
    .filter(t => !billed.has(t.id))
    .map((t: any) => ({
      id: t.id,
      title: t.title,
      task_date: t.task_date,
      status: t.status,
      quantity: t.quantity,
      currency: t.currency,
      ...(vis.billingLinePricing ? { billing_amount: t.billing_amount ?? t.billing_amount_inr ?? 0 } : {}),
      service_name: t.service?.name ?? null,
    }))
  return { ok: true, data: missed }
}

/**
 * Add finished tasks to an invoice as lines, priced from the task exactly as
 * Generate from tasks does. A draft or reviewed invoice takes them directly; a
 * sent one only with a reason, which goes to its edit history, and its new
 * tasks are marked invoiced like the rest of its lines. A paid or closed
 * invoice is refused — the client has settled it.
 */
export async function addTasksToInvoice(
  invoiceId: string,
  taskIds: string[],
  reason?: string,
): Promise<ActionResult<{ added: number }>> {
  const guard = await requirePermission(PERMS.BILLING_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!taskIds.length) return { ok: false, error: 'No tasks selected' }

  const admin = createAdminClient()
  const { data: inv } = await admin.from('invoices')
    .select('id, client_id, status, tax_rate, tax_amount, discount_amount, previous_balance')
    .eq('id', invoiceId).maybeSingle()
  if (!inv) return { ok: false, error: 'Invoice not found' }

  const open = (ADD_LINES_OPEN as readonly string[]).includes(inv.status)
  const needsReason = (ADD_LINES_WITH_REASON as readonly string[]).includes(inv.status)
  if (!open && !needsReason) {
    return { ok: false, error: `This invoice is ${inv.status}. Add the tasks to the next draft instead.` }
  }
  if (needsReason && !reason?.trim()) {
    return { ok: false, error: 'This invoice has been sent — give a reason for adding lines.' }
  }

  const { data: tasks } = await admin.from('tasks')
    .select('id, title, task_date, client_id, status, quantity, currency, billing_amount, billing_amount_inr, is_billable, deleted_at')
    .in('id', taskIds)
  // Re-check on the server: right client, still billable, and not billed in
  // the meantime by another tab or the automatic sync.
  const billed = await tasksOnLiveInvoices(admin, taskIds)
  const eligible = (tasks || []).filter(t =>
    t.client_id === inv.client_id && !t.deleted_at && t.is_billable !== false
    && ['done', 'invoiced'].includes(t.status) && !billed.has(t.id))
  if (!eligible.length) return { ok: false, error: 'Those tasks are already on an invoice.' }

  const { count } = await admin.from('invoice_items')
    .select('id', { count: 'exact', head: true }).eq('invoice_id', invoiceId)
  const offset = count || 0
  // Same convention as Generate from tasks: billing_amount is the line total
  // in the task's own currency; the rate is derived back out of it.
  const { error: insErr } = await admin.from('invoice_items').insert(
    eligible.map((t, idx) => {
      const qty = Number(t.quantity ?? 1) || 1
      const total = Number(t.billing_amount ?? t.billing_amount_inr ?? 0)
      return {
        invoice_id: invoiceId, task_id: t.id, description: t.title,
        quantity: qty, unit_price: r2(total / qty), total,
        currency: t.currency || 'INR', display_order: offset + idx,
      }
    }),
  )
  if (insErr) return { ok: false, error: insErr.message }

  if (needsReason) {
    await admin.from('tasks').update({ status: 'invoiced' }).in('id', eligible.map(t => t.id))
    await admin.from('invoice_change_logs').insert({
      invoice_id: invoiceId, field_name: 'items_added',
      old_value: '', new_value: eligible.map(t => t.title).join('; '), reason: reason!.trim(),
    })
  } else {
    // A draft's package lines collapse covered tasks back into the fee line.
    try { await syncInvoicePackageLines(admin, invoiceId) } catch { /* best-effort */ }
  }

  await recalcInvoiceTotals(admin, invoiceId)
  revalidatePath('/dashboard/invoices')
  return { ok: true, data: { added: eligible.length } }
}

/** Task ids that already sit on a line of any invoice that is not cancelled. */
async function tasksOnLiveInvoices(admin: ReturnType<typeof createAdminClient>, taskIds: string[]): Promise<Set<string>> {
  const billed = new Set<string>()
  // Chunked: a year of tasks for a busy client overflows a single IN list.
  for (let i = 0; i < taskIds.length; i += 200) {
    const { data } = await admin.from('invoice_items')
      .select('task_id, invoice:invoices!inner(status)')
      .in('task_id', taskIds.slice(i, i + 200))
    for (const row of (data || []) as any[]) {
      if (row.task_id && row.invoice?.status !== 'cancelled') billed.add(row.task_id)
    }
  }
  return billed
}

/** Recompute subtotal, tax and total from the lines actually on the invoice. */
async function recalcInvoiceTotals(admin: ReturnType<typeof createAdminClient>, invoiceId: string) {
  const [{ data: items }, { data: exps }, { data: inv }] = await Promise.all([
    admin.from('invoice_items').select('total').eq('invoice_id', invoiceId),
    admin.from('invoice_expense_items').select('amount').eq('invoice_id', invoiceId),
    admin.from('invoices').select('tax_rate, tax_amount, discount_amount, previous_balance').eq('id', invoiceId).single(),
  ])
  const subtotal = r2((items || []).reduce((s, r) => s + (r.total || 0), 0) + (exps || []).reduce((s, r) => s + (r.amount || 0), 0))
  const rate = Number(inv?.tax_rate || 0)
  const tax = rate > 0 ? r2(subtotal * rate / 100) : Number(inv?.tax_amount || 0)
  const total = Math.max(0, r2(subtotal + tax - Number(inv?.discount_amount || 0) + Number(inv?.previous_balance || 0)))
  await admin.from('invoices').update({
    subtotal, tax_amount: tax, total_amount: total, updated_at: new Date().toISOString(),
  }).eq('id', invoiceId)
}

// ── Service column on the printed invoice ────────────────────────────────────
//
// Who may reshape a client-facing document is the same question as who may
// move an invoice through its workflow — the people who send them. Gated on
// the pair rather than billing.edit alone for the reason recorded in
// RECORD_PAYMENT_PERMS: a collections role that sends invoices is exactly who
// needs this, and refusing them would repeat the split that made "Permission
// denied." appear on one screen for something allowed on another.
const INVOICE_PRESENTATION_PERMS = [PERMS.BILLING_EDIT, PERMS.BILLING_VIEW_WORKFLOW] as const

/**
 * Set (or clear) the Service column override for ONE invoice.
 * `null` means "follow the client's default" — see lib/invoices/service-column.
 */
export async function setInvoiceServiceColumn(
  invoiceId: string,
  value: boolean | null,
): Promise<ActionResult<null>> {
  const guard = await requireAnyPermission(INVOICE_PRESENTATION_PERMS)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!invoiceId) return { ok: false, error: 'Missing invoice.' }

  try {
    const admin = createAdminClient()
    const { error } = await admin
      .from('invoices')
      .update({ show_service_column: value, updated_at: new Date().toISOString() })
      .eq('id', invoiceId)
    if (error) return { ok: false, error: missingColumn(error.message) }
    revalidatePath('/dashboard/invoices')
    return { ok: true, data: null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? missingColumn(err.message) : 'Could not save.' }
  }
}

/** Set the client's standing rule, and clear this invoice's override so it follows. */
export async function setClientServiceColumnDefault(
  clientId: string,
  value: boolean,
  alsoClearInvoiceId?: string,
): Promise<ActionResult<null>> {
  const guard = await requireAnyPermission(INVOICE_PRESENTATION_PERMS)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!clientId) return { ok: false, error: 'Missing client.' }

  try {
    const admin = createAdminClient()
    const { error } = await admin
      .from('clients')
      .update({ invoice_show_services: value })
      .eq('id', clientId)
    if (error) return { ok: false, error: missingColumn(error.message) }
    if (alsoClearInvoiceId) {
      await admin.from('invoices').update({ show_service_column: null }).eq('id', alsoClearInvoiceId)
    }
    revalidatePath('/dashboard/invoices')
    return { ok: true, data: null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? missingColumn(err.message) : 'Could not save.' }
  }
}

/**
 * Turn "that column isn't there" into something a person can act on.
 *
 * Two different wordings reach here and both had to be matched by hand:
 * Postgres says `column "x" does not exist`, while PostgREST answers a write
 * against an unknown column with PGRST204 — "Could not find the 'x' column of
 * 'invoices' in the schema cache". Only the second one actually shows up on
 * this path, which is exactly what the first version of this function missed.
 */
function missingColumn(message: string): string {
  const unknownColumn =
    /column .* does not exist/i.test(message) ||
    /could not find the .* column/i.test(message) ||
    /schema cache/i.test(message)
  return unknownColumn
    ? 'The Service column needs migration 20260902100000 applied first — see supabase/APPLIED.md.'
    : message
}
