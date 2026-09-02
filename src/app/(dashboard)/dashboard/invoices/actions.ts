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
      items:invoice_items(*, task:tasks(id, title, task_date, status, billing_amount_inr, currency), service:services(id, name)),
      cashbook_invoice_allocations(id, deleted_at, allocated_amount, cashbook_entry:cashbook_entries(id, reference, entry_date, description, receipt_number, bank_account:bank_accounts(name)))
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
