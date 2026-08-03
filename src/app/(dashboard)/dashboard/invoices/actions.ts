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
import { syncDraftInvoices } from '@/lib/sync/integrity'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

export type { RecordInvoicePaymentInput }

/**
 * `employeeId` is deliberately NOT part of the caller's input: it is resolved
 * from the session so a client cannot attribute a payment to someone else.
 */
export type RecordInvoicePaymentArgs = Omit<RecordInvoicePaymentInput, 'employeeId'>

export async function recordInvoicePayment(
  input: RecordInvoicePaymentArgs,
): Promise<ActionResult<{ paymentId: string; cashbookEntryId: string | null; receiptNumber: string | null }>> {
  const guard = await requirePermission(PERMS.BILLING_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const result = await recordPayment({ ...input, employeeId: guard.employeeId ?? null })
  if (!result.ok) {
    return { ok: false, error: result.error }
  }

  revalidatePath('/dashboard/invoices')
  revalidatePath('/dashboard/cashbook')

  return result
}

export async function serverResyncInvoiceTasks(invoiceId: string): Promise<ActionResult<{ syncedTasks: number }>> {
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
  
  revalidatePath('/dashboard/invoices')
  return { ok: true, data: { syncedTasks: allIds.length } }
}
