import { redirect } from 'next/navigation'
import { createAdminClient, fetchAll, stablePaginationQuery } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { getCompanySettings } from '@/lib/settings/company-settings'
import StatementsClient from './statements-client'
import type { StatementCredit, StatementInvoice } from '@/lib/statements/build'

export const dynamic = 'force-dynamic'

/**
 * Statement of Account.
 *
 * Loads the whole billing history once — a statement's opening balance is
 * everything before the period, so windowing the fetch would silently make the
 * carried-forward figure wrong. The payload stays small because only ledger
 * columns are selected: no line items, no joins beyond the client name.
 */
export default async function StatementsPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  if (me && !(isAdmin || hasPermission(me, PERMS.BILLING_VIEW_INVOICES))) redirect('/dashboard')

  const supabase = createAdminClient()

  const [clientsRes, invoicesRes, paymentsRes, allocationsRes, companySettings] = await Promise.all([
    supabase.from('clients')
      .select('id, name, code, phone, email, address')
      .eq('is_active', true)
      .order('name'),
    fetchAll(stablePaginationQuery(
      supabase.from('invoices')
        .select('id, invoice_number, issue_date, due_date, status, currency, total_amount, paid_amount, total_amount_inr, paid_amount_inr, exchange_rate, client_id')
    )),
    fetchAll(stablePaginationQuery(
      supabase.from('payments')
        .select('invoice_id, payment_date, amount, amount_inr, payment_method, reference')
    )),
    fetchAll(stablePaginationQuery(
      supabase.from('cashbook_invoice_allocations')
        .select('invoice_id, allocated_amount, deleted_at, cashbook_entry:cashbook_entries(entry_date, reference)')
    )),
    getCompanySettings(),
  ])

  const invoices = (invoicesRes.data || []) as (StatementInvoice & { client_id: string | null })[]

  // Both money paths, normalised to INR. buildStatement de-duplicates the pairs
  // that recordInvoicePayment creates (a payment row AND the allocation of the
  // cashbook entry it auto-creates are the same money).
  const credits: (StatementCredit & { _k: string })[] = []
  for (const p of (paymentsRes.data || []) as Record<string, unknown>[]) {
    if (!p.invoice_id || !p.payment_date) continue
    credits.push({
      _k: `p${credits.length}`,
      invoiceId: String(p.invoice_id),
      date: String(p.payment_date),
      amountInr: Number(p.amount_inr ?? p.amount ?? 0),
      source: 'payment',
      method: (p.payment_method as string) ?? null,
      reference: (p.reference as string) ?? null,
    })
  }
  for (const a of (allocationsRes.data || []) as Record<string, unknown>[]) {
    if (a.deleted_at || !a.invoice_id) continue
    const entry = a.cashbook_entry as { entry_date?: string; reference?: string } | null
    if (!entry?.entry_date) continue
    credits.push({
      _k: `a${credits.length}`,
      invoiceId: String(a.invoice_id),
      date: entry.entry_date,
      amountInr: Number(a.allocated_amount ?? 0),
      source: 'allocation',
      reference: entry.reference ?? null,
      method: null,
    })
  }

  return (
    <StatementsClient
      clients={(clientsRes.data || []) as never}
      invoices={invoices as never}
      credits={credits as never}
      companySettings={companySettings as Record<string, string>}
      canViewAmounts={isAdmin || hasPermission(me, PERMS.BILLING_VIEW_AMOUNTS)}
    />
  )
}
