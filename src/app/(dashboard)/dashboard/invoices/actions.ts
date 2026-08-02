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
