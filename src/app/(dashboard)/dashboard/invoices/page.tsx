import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { financialVisibility, stripInvoiceList } from '@/lib/permissions/strip'
import { getPendingPricing } from '@/lib/pricing/pending'
import { PricingPendingBanner } from '@/components/pricing/pricing-pending-banner'
import InvoicesClient from './invoices-client'

export const dynamic = 'force-dynamic'

export default async function InvoicesPage() {
  // Route is permission-gated by middleware (`billing.view_invoices`).
  // Per-field financial visibility (totals, line pricing, payments) is gated
  // below by stripping fields from the payload when the user lacks the
  // corresponding `billing.view_amounts` / `billing.view_line_pricing` perm.
  const me = await loadCurrentUser().catch(() => null)
  const vis = financialVisibility(me)
  const supabase = createAdminClient()

  const [invoicesRes, clientsRes, bankRes, servicesRes, settingsRes, ratesRes, categoriesRes] = await Promise.all([
    // Note: this is the biggest single query on the page (HAR shows 7.5s cold).
    // The nested task+service joins inside `items` are needed by the editor,
    // PDF generator, and invoice rows — can't safely drop them without a
    // client refactor. Caps at 500 most-recent invoices to bound the payload.
    supabase
      .from('invoices')
      .select(`
        *,
        client:clients(id, name, code, phone, email, address),
        items:invoice_items(
          *,
          task:tasks(id, title, task_date, status, billing_amount_inr, currency),
          service:services(id, name)
        ),
        payments(id, amount, currency, exchange_rate, amount_inr, payment_date, payment_method, reference, notes),
        cashbook_invoice_allocations(id, deleted_at, allocated_amount, cashbook_entry:cashbook_entries(id, reference, entry_date, description, receipt_number, bank_account:bank_accounts(name))),
        expense_items:invoice_expense_items(id, cashbook_entry_id, description, amount, amount_inr, currency, original_amount, original_amount_inr, markup_type, markup_value, markup_amount, notes)
      `)
      .order('created_at', { ascending: false })
      .limit(500),
    supabase
      .from('clients')
      .select('id, name, code, phone, email, address, default_currency')
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('bank_accounts')
      .select('id, name, is_default')
      .eq('is_active', true),
    supabase
      .from('services')
      .select('id, name')
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('company_settings')
      .select('key, value'),
    supabase
      .from('exchange_rates')
      .select('*'),
    supabase
      .from('cashbook_categories')
      .select('*')
      .order('type')
      .order('name'),
  ])

  // Convert settings array to a key→value map
  const settings: Record<string, string> = {}
  ;(settingsRes.data || []).forEach(s => { settings[s.key] = s.value })

  // Server-side strip: when the user lacks view_amounts and/or view_line_pricing,
  // the corresponding ₹ fields are deleted from the payload BEFORE serialisation
  // so they never appear in the RSC stream, network response, or DevTools state.
  const initialInvoices = stripInvoiceList(
    (invoicesRes.data || []) as any[],
    { amounts: vis.billingAmounts, linePricing: vis.billingLinePricing },
  )

  // Pending-to-price banner — only for users who can see invoice amounts/pricing.
  const canSeePricing = (me?.isAdmin ?? false) || vis.billingAmounts || vis.billingLinePricing
  const pendingPricing = canSeePricing ? await getPendingPricing(supabase) : { clients: [], services: [], total: 0 }

  return (
    <>
    {canSeePricing && <PricingPendingBanner clients={pendingPricing.clients} services={pendingPricing.services} />}
    <InvoicesClient
      initialInvoices={initialInvoices}
      clients={clientsRes.data || []}
      bankAccounts={bankRes.data || []}
      cashbookCategories={categoriesRes.data || []}
      services={servicesRes.data || []}
      companySettings={settings}
      exchangeRates={ratesRes.data || []}
      visibility={{
        amounts:     vis.billingAmounts,
        linePricing: vis.billingLinePricing,
      }}
    />
    </>
  )
}
