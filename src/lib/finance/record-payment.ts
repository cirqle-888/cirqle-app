import { createAdminClient } from '@/lib/supabase/admin'
import { retryWithoutScope, withoutScope } from '@/lib/finance/classify'
import { logActivity } from '@/lib/activity/log'
import { revalidatePath } from 'next/cache'

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
  // Deltas for the ATOMIC path
  appliedInvoiceCcy?: number
  appliedInr?:        number
  // Category
  categoryId:      string | null
  // Caller
  employeeId:      string | null
}

export async function recordPayment(
  input: RecordInvoicePaymentInput
): Promise<{ ok: boolean; error?: string; data?: { paymentId: string; cashbookEntryId: string | null; receiptNumber: string | null } }> {
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

  // 2. Update invoice paid_amount / status.
  let balanceUpdated = false
  if (typeof input.appliedInvoiceCcy === 'number' && typeof input.appliedInr === 'number') {
    const { error: rpcErr } = await (admin as any).rpc('increment_invoice_paid', {
      p_invoice_id: input.invoiceId,
      p_delta:      input.appliedInvoiceCcy,
      p_delta_inr:  input.appliedInr,
    })
    if (!rpcErr) {
      balanceUpdated = true
    } else if (rpcErr.code !== 'PGRST202' && !/function .* does not exist/i.test(rpcErr.message ?? '')) {
      return { ok: false, error: rpcErr.message }
    }
  }
  if (!balanceUpdated) {
    const { error: invErr } = await admin
      .from('invoices')
      .update({
        paid_amount:     input.newPaid,
        paid_amount_inr: input.newPaidInr,
        status:          input.newStatus,
      })
      .eq('id', input.invoiceId)

    if (invErr) return { ok: false, error: invErr.message }
  }

  // 3. Generate receipt number
  let receiptNumber: string | null = null
  try {
    const { data: rcpt } = await (admin as any).rpc('generate_receipt_number', {
      p_entry_date:  input.paymentDate,
      p_client_code: input.clientCode?.toUpperCase() || null,
    })
    receiptNumber = rcpt || null
  } catch {}

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
    scope:           input.clientId ? ('client' as const) : null,
  }
  const { data: entry, error: entryErr } = await retryWithoutScope(strip =>
    admin
      .from('cashbook_entries')
      .insert(strip ? withoutScope(paymentRow) : paymentRow)
      .select('id')
      .single()
  )

  void logActivity({
    actorId: input.employeeId, entityType: 'invoice', entityId: input.invoiceId,
    action: 'payment_received', category: 'billing', clientId: input.clientId ?? null,
    detail: { label: input.invoiceNumber, amount: input.amount, currency: input.currency, status: input.newStatus },
  })

  if (entryErr || !entry) {
    console.error('[recordPayment] cashbook entry insert failed:', entryErr)
    return { ok: true, data: { paymentId: pmt.id, cashbookEntryId: null, receiptNumber } }
  }

  // 5. Allocate
  await admin.from('cashbook_invoice_allocations').insert({
    cashbook_entry_id:  entry.id,
    invoice_id:         input.invoiceId,
    allocated_amount:   input.amountInr,
  })

  return { ok: true, data: { paymentId: pmt.id, cashbookEntryId: entry.id, receiptNumber } }
}
