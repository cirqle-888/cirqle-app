'use server'

/**
 * Invoice server actions — write operations that need server-side access.
 *
 * recordInvoicePayment: records a payment AND auto-creates a matching cashbook
 * inflow entry so the payment appears immediately on the Cashbook page.
 */

import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
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
  const guard = await requirePermission(PERMS.BILLING_EDIT)
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
