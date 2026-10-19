// rls: browser-client — called from the Quotations pages with the browser client (scripts/rls-keep-list.mjs rule 4)
/**
 * Quotation status changes and quotation → invoice conversion.
 *
 * Moved out of the Quotations list so the list and the quotation page share
 * one implementation. The invoice number now comes from the invoices' own
 * numbering (lib/invoices/numbering: INV-<yymm>-<CODE>, then A, -2, …); the
 * list used to carry a private copy that produced INV-<yymm>-<CODE>-<seq>,
 * a format no other invoice uses.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { daysFromTodayISO, todayISO } from '@/lib/utils/local-date'
import { generateInvoiceNumber } from '@/lib/invoices/numbering'

type Client = SupabaseClient

export const QUOTATION_STATUSES = ['draft', 'sent', 'approved', 'rejected', 'converted'] as const

/** Approving or rejecting is an outcome, not a step, so the UI confirms those two first. */
export function statusNeedsConfirm(status: string): boolean {
  return status === 'approved' || status === 'rejected'
}

export async function setQuotationStatus(supabase: Client, id: string, status: string): Promise<string | null> {
  const { error } = await supabase.from('quotations').update({ status }).eq('id', id)
  return error ? error.message : null
}

export interface ConvertibleQuotation {
  id: string
  client_id: string
  currency: string
  total_amount: number
  notes?: string | null
  client?: { code?: string | null } | null
  items?: { description: string; quantity: number; unit_price: number; total: number }[] | null
}

/** Create a draft invoice from the quotation's lines and mark the quotation converted. */
export async function convertQuotationToInvoice(supabase: Client, quo: ConvertibleQuotation): Promise<void> {
  // 1. Quotation items
  const { data: qItems, error: itemsError } = await supabase
    .from('quotation_items')
    .select('*')
    .eq('quotation_id', quo.id)
    .order('display_order')
  if (itemsError) throw itemsError
  const items = (qItems || quo.items || []) as NonNullable<ConvertibleQuotation['items']>

  // 2. Invoice number
  const issueDate = todayISO()
  const dueDate = daysFromTodayISO(14)
  const { invoiceNumber } = await generateInvoiceNumber(supabase, new Date(), (quo.client?.code || '001').toUpperCase())

  // 3. Invoice
  const { data: inv, error: invError } = await supabase
    .from('invoices')
    .insert({
      invoice_number: invoiceNumber,
      client_id: quo.client_id,
      quotation_id: quo.id,
      status: 'draft',
      issue_date: issueDate,
      due_date: dueDate,
      currency: quo.currency,
      total_amount: quo.total_amount,
      subtotal: quo.total_amount,
      tax_rate: 0,
      tax_amount: 0,
      discount_amount: 0,
      previous_balance: 0,
      notes: quo.notes || '',
    })
    .select('id')
    .single()
  if (invError) throw invError

  // 4. Invoice items
  if (items.length > 0) {
    const { error: invItemsError } = await supabase.from('invoice_items').insert(items.map((item, index) => ({
      invoice_id: inv.id,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      total: item.total,
      currency: quo.currency,
      display_order: index,
    })))
    if (invItemsError) throw invItemsError
  }

  // 5. Quotation → converted
  await supabase.from('quotations').update({ status: 'converted' }).eq('id', quo.id)
}
