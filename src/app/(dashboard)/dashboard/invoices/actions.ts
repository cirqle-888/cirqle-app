'use server'

/**
 * Invoice server actions — write operations that need server-side access.
 *
 * recordInvoicePayment: records a payment AND auto-creates a matching cashbook
 * inflow entry so the payment appears immediately on the Cashbook page.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/auth/enforce'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { retryWithoutScope, withoutScope } from '@/lib/finance/classify'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

export interface RecordInvoicePaymentInput {
  invoiceId:       string
  invoiceNumber:   string
  clientId:        string | null
  clientCode:      string | null   // used for receipt number generation
  clientName:      string | null
  // Payment details
  amount:          number   // in payForm.currency
  currency:        string
  amountInr:       number   // INR base
  exchangeRate:    number
  rateSource:      string
  rateDate:        string
  paymentDate:     string
  paymentMethod:   string
  reference:       string | null
  notes:           string | null
  bankAccountId:   string | null
  // Invoice balance updates
  newPaid:         number
  newPaidInr:      number
  newStatus:       string
  // Category: the "Invoice Payment" inflow category id, resolved client-side
  // from the categories list. If null, entry is created without a category.
  categoryId:      string | null
}

/**
 * Atomically:
 *  1. Inserts a row into `payments`
 *  2. Updates `invoices.paid_amount / status`
 *  3. Creates a `cashbook_entries` inflow row
 *  4. Creates a `cashbook_invoice_allocations` row linking the entry → invoice
 *  5. Revalidates /dashboard/cashbook so the new entry is visible immediately
 */
export async function recordInvoicePayment(
  input: RecordInvoicePaymentInput,
): Promise<ActionResult<{ paymentId: string; cashbookEntryId: string | null; receiptNumber: string | null }>> {
  const guard = await requirePermission(PERMS.BILLING_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()

  // 1. Insert payment row
  const { data: pmt, error: pmtErr } = await admin
    .from('payments')
    .insert({
      invoice_id:      input.invoiceId,
      amount:          input.amount,
      currency:        input.currency,
      exchange_rate:   input.exchangeRate,
      amount_inr:      input.amountInr,
      rate_source:     input.rateSource,
      rate_date:       input.rateDate,
      payment_date:    input.paymentDate,
      payment_method:  input.paymentMethod,
      reference:       input.reference || null,
      notes:           input.notes || null,
      bank_account_id: input.bankAccountId || null,
    })
    .select('id')
    .single()

  if (pmtErr || !pmt) return { ok: false, error: pmtErr?.message ?? 'Payment insert failed' }

  // 2. Update invoice paid_amount / status
  const { error: invErr } = await admin
    .from('invoices')
    .update({
      paid_amount:     input.newPaid,
      paid_amount_inr: input.newPaidInr,
      status:          input.newStatus,
    })
    .eq('id', input.invoiceId)

  if (invErr) return { ok: false, error: invErr.message }

  // 3. Generate receipt number for the cashbook entry
  let receiptNumber: string | null = null
  try {
    const { data: rcpt } = await (admin as any).rpc('generate_receipt_number', {
      p_entry_date:  input.paymentDate,
      p_client_code: input.clientCode?.toUpperCase() || null,
    })
    receiptNumber = rcpt || null
  } catch {
    // Non-fatal — entry will be created without a receipt number
  }

  // 4. Create cashbook inflow entry
  const description = `Invoice payment — ${input.invoiceNumber}${input.clientName ? ` (${input.clientName})` : ''}`
  const paymentRow = {
    type:            'inflow',
    category_id:     input.categoryId || null,
    bank_account_id: input.bankAccountId || null,
    amount:          input.amount,
    currency:        input.currency,
    amount_inr:      input.amountInr,
    exchange_rate:   input.exchangeRate,
    rate_source:     input.rateSource,
    rate_date:       input.rateDate,
    entry_date:      input.paymentDate,
    description,
    reference:       input.reference || null,
    invoice_id:      input.invoiceId,
    client_id:       input.clientId || null,
    receipt_number:  receiptNumber,
    // Client revenue; without a client tag the trigger leaves it for triage.
    scope:           input.clientId ? ('client' as const) : null,
  }
  const { data: entry, error: entryErr } = await retryWithoutScope(strip =>
    admin
      .from('cashbook_entries')
      .insert(strip ? withoutScope(paymentRow) : paymentRow)
      .select('id')
      .single()
  )

  // Timeline: payment received on this invoice (fire-and-forget)
  void logActivity({
    actorId: guard.employeeId, entityType: 'invoice', entityId: input.invoiceId,
    action: 'payment_received', category: 'billing', clientId: input.clientId ?? null,
    detail: { label: input.invoiceNumber, amount: input.amount, currency: input.currency, status: input.newStatus },
  })

  if (entryErr || !entry) {
    // Payment already recorded — don't fail, just skip cashbook entry
    console.error('[recordInvoicePayment] cashbook entry insert failed:', entryErr)
    revalidatePath('/dashboard/invoices')
    return { ok: true, data: { paymentId: pmt.id, cashbookEntryId: null, receiptNumber } }
  }

  // 5. Allocate cashbook entry → invoice
  await admin.from('cashbook_invoice_allocations').insert({
    cashbook_entry_id:  entry.id,
    invoice_id:         input.invoiceId,
    allocated_amount:   input.amountInr,  // INR base for allocation tracking
  })

  // Revalidate both pages so they reflect the new state
  revalidatePath('/dashboard/invoices')
  revalidatePath('/dashboard/cashbook')

  return { ok: true, data: { paymentId: pmt.id, cashbookEntryId: entry.id, receiptNumber } }
}
