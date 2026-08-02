'use server'

/**
 * Server actions for the invoice Follow-ups (collections) page.
 *
 * Writes are gated by billing.edit OR billing.view_workflow (a collections
 * person who can action invoice status, but isn't necessarily a full
 * invoice editor, can still log follow-ups and mark drafts sent).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { requireAnyPermission } from '@/lib/permissions/check'
import { logActivity } from '@/lib/activity/log'
import { revalidatePath } from 'next/cache'
import { recordPayment as libRecordPayment } from '@/lib/finance/record-payment'

const ROUTE = '/dashboard/invoices/follow-ups'
const WRITE_PERMS = ['billing.edit', 'billing.view_workflow']

export interface LogFollowupInput {
  invoiceId:         string
  note?:             string | null
  outcome?:          string | null
  promisedDate?:     string | null
  nextFollowupDate?: string | null
}

/** Append a follow-up row to an invoice's collections log. */
export async function logFollowup(input: LogFollowupInput): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireAnyPermission(WRITE_PERMS)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!input.invoiceId) return { ok: false, error: 'Missing invoice' }

  const hasContent = !!(
    input.note?.trim() || input.outcome || input.promisedDate || input.nextFollowupDate
  )
  if (!hasContent) return { ok: false, error: 'Add a note, outcome, or a date first' }

  try {
    const admin = createAdminClient()
    const { error } = await admin.from('invoice_followups').insert({
      invoice_id:         input.invoiceId,
      note:               input.note?.trim() || null,
      outcome:            input.outcome || null,
      promised_date:      input.promisedDate || null,
      next_followup_date: input.nextFollowupDate || null,
      created_by:         guard.employeeId ?? null,
    })
    if (error) {
      if (/relation|does not exist|schema cache/i.test(error.message)) {
        return { ok: false, error: 'Follow-ups table not found — run migration 20260616120000.' }
      }
      return { ok: false, error: error.message }
    }
    revalidatePath(ROUTE)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Failed to log follow-up' }
  }
}

/** Remove a mistaken follow-up entry. */
export async function deleteFollowup(id: string): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireAnyPermission(WRITE_PERMS)
  if (!guard.ok) return { ok: false, error: guard.error }
  try {
    const admin = createAdminClient()
    const { error } = await admin.from('invoice_followups').delete().eq('id', id)
    if (error) return { ok: false, error: error.message }
    revalidatePath(ROUTE)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Failed to delete follow-up' }
  }
}

/**
 * Mark a draft/reviewed invoice as Sent, right from the follow-ups page.
 * Mirrors the single mark-sent path in invoices-client.tsx:
 *   - due_date = existing due_date, else issue_date + 30 (NOT today + 30)
 *   - linked tasks → status 'invoiced'
 *   - logs an 'invoice status_changed' activity event
 */
export async function markInvoiceSent(
  invoiceId: string,
): Promise<{ ok: boolean; error?: string; dueDate?: string }> {
  const guard = await requireAnyPermission(WRITE_PERMS)
  if (!guard.ok) return { ok: false, error: guard.error }

  try {
    const admin = createAdminClient()
    const { data: inv, error: fErr } = await admin
      .from('invoices')
      .select('id, status, issue_date, due_date, items:invoice_items(task_id)')
      .eq('id', invoiceId)
      .single()
    if (fErr || !inv) return { ok: false, error: fErr?.message ?? 'Invoice not found' }
    if (!['draft', 'reviewed'].includes(inv.status)) {
      return { ok: false, error: `Invoice is already ${inv.status}` }
    }

    // Net-30 from the invoice's OWN issue date (not today) when no due date set,
    // so a back-dated invoice gets a correct (possibly already-overdue) due date.
    let dueDate = (inv.due_date as string | null) || null
    if (!dueDate) {
      const base = inv.issue_date ? new Date(inv.issue_date) : new Date()
      base.setDate(base.getDate() + 30)
      dueDate = base.toISOString().split('T')[0]
    }

    const prevStatus = inv.status
    const { error: uErr } = await admin
      .from('invoices')
      .update({ status: 'sent', due_date: dueDate, updated_at: new Date().toISOString() })
      .eq('id', invoiceId)
    if (uErr) return { ok: false, error: uErr.message }

    // Flip linked tasks to 'invoiced' (same as the invoices page).
    const taskIds = (((inv as any).items || []) as any[])
      .map(it => it.task_id)
      .filter(Boolean)
    if (taskIds.length) {
      await admin.from('tasks').update({ status: 'invoiced' }).in('id', taskIds)
    }

    void logActivity({
      actorId:    guard.employeeId ?? null,
      entityType: 'invoice',
      entityId:   invoiceId,
      action:     'status_changed',
      detail:     { field: 'status', from: prevStatus, to: 'sent', via: 'follow-ups' },
    })

    revalidatePath(ROUTE)
    return { ok: true, dueDate }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Failed to mark invoice sent' }
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

export interface RecordPaymentInput {
  invoiceId:     string
  amount:        number          // in the invoice's own currency
  paymentDate?:  string | null   // YYYY-MM-DD, defaults to today
  method?:       string | null   // bank_transfer | cash | upi | cheque | online | other
  reference?:    string | null
}

/**
 * Record a payment received against an invoice, from the Follow-ups page.
 * Mirrors the Invoices-page "Quick Pay" math (paid_amount in invoice currency,
 * paid_amount_inr in INR, status paid/partial). Assumes the payment is in the
 * invoice's own currency (the collections common case) — cross-currency edits
 * stay on the Invoices page.
 *
 * GUARD: refuses if the invoice has any active cash-book allocation. Direct
 * payments and cash-book allocations are mutually exclusive (see the allocation
 * engine), so those invoices must be settled from the Invoices page instead.
 */
export async function recordPayment(
  input: RecordPaymentInput,
): Promise<{ ok: boolean; error?: string; status?: string }> {
  const guard = await requireAnyPermission(WRITE_PERMS)
  if (!guard.ok) return { ok: false, error: guard.error }
  const amount = Number(input.amount)
  if (!input.invoiceId) return { ok: false, error: 'Missing invoice' }
  if (!(amount > 0)) return { ok: false, error: 'Enter a valid amount' }

  try {
    const admin = createAdminClient()
    const { data: inv, error: fErr } = await admin
      .from('invoices')
      .select('id, status, currency, exchange_rate, total_amount, paid_amount, paid_amount_inr, invoice_number, client_id, client:clients(id,name,code), cashbook_invoice_allocations(id, deleted_at)')
      .eq('id', input.invoiceId)
      .single()
    if (fErr || !inv) return { ok: false, error: fErr?.message ?? 'Invoice not found' }
    if (['paid', 'cancelled', 'bad_debt'].includes(inv.status)) {
      return { ok: false, error: `Invoice is ${inv.status}` }
    }

    // Allocation invariant: don't mix direct payments with cash-book allocations.
    const hasAllocations = (((inv as any).cashbook_invoice_allocations || []) as any[])
      .some(a => !a.deleted_at)
    if (hasAllocations) {
      return { ok: false, error: 'This invoice is settled via Cash Book allocations — record payment from the Invoices page.' }
    }

    const isBase = (inv.currency || 'INR') === 'INR'
    const invRate = (inv.exchange_rate && inv.exchange_rate > 0) ? inv.exchange_rate : 1
    const amountInr = isBase ? amount : round2(amount * invRate)

    const newPaid    = round2((inv.paid_amount || 0) + amount)            // invoice currency
    const newPaidInr = round2((inv.paid_amount_inr || 0) + amountInr)     // INR base
    const balance    = (inv.total_amount || 0) - newPaid
    const newStatus  = balance <= 0.001 ? 'paid' : 'partial'
    
    const clientData = (inv as any).client as any

    const res = await libRecordPayment({
      invoiceId: input.invoiceId,
      invoiceNumber: inv.invoice_number || 'N/A',
      clientId: inv.client_id || null,
      clientCode: clientData?.code || null,
      clientName: clientData?.name || null,
      amount: amount,
      currency: inv.currency || 'INR',
      amountInr: amountInr,
      exchangeRate: invRate,
      rateSource: 'follow-ups',
      rateDate: new Date().toISOString().split('T')[0],
      paymentDate: input.paymentDate || new Date().toISOString().split('T')[0],
      paymentMethod: input.method || 'bank_transfer',
      reference: input.reference || null,
      notes: 'Recorded via Follow-ups',
      bankAccountId: null,
      newPaid,
      newPaidInr,
      newStatus,
      appliedInvoiceCcy: amount,
      appliedInr: amountInr,
      categoryId: null, // Let triage handle category if no default
      employeeId: guard.employeeId ?? null,
    })

    if (!res.ok) return { ok: false, error: res.error }

    // Auto-log a follow-up entry so the timeline reflects the payment.
    await admin.from('invoice_followups').insert({
      invoice_id: input.invoiceId,
      note:       `Payment of ₹${Math.round(amountInr).toLocaleString('en-IN')} recorded${newStatus === 'paid' ? ' — invoice fully paid' : ' (partial)'}.`,
      outcome:    'other',
      created_by: guard.employeeId ?? null,
    }).then(() => {}, () => {}) // best-effort; table may not exist pre-migration

    revalidatePath(ROUTE)
    return { ok: true, status: newStatus }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Failed to record payment' }
  }
}

export async function setClientGreeting(clientId: string, greetingName: string | null) {
  const supabase = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Unauthorized' }

  if (!greetingName) {
    const { error } = await supabase
      .from('employee_client_preferences')
      .delete()
      .match({ employee_id: user.id, client_id: clientId })

    if (error) return { ok: false, error: error.message }
  } else {
    const { error } = await supabase
      .from('employee_client_preferences')
      .upsert({
        employee_id: user.id,
        client_id: clientId,
        greeting_name: greetingName,
      })

    if (error) return { ok: false, error: error.message }
  }

  return { ok: true }
}
