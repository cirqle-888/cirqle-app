import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { financialVisibility, stripInvoiceList } from '@/lib/permissions/strip'
import { getPendingPricing } from '@/lib/pricing/pending'
import { PricingPendingBanner } from '@/components/pricing/pricing-pending-banner'
import { getCompanySettings } from '@/lib/settings/company-settings'
import { loadAgreementBreakdowns } from '@/lib/packages/invoice-breakdown'
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
    // The list query. `items` and `cashbook_invoice_allocations` are
    // deliberately NOT joined here: measured across 270 invoices they were
    // 988 KB and 154 KB of a 1375 KB payload, and nothing on the LIST needs
    // either — only the selected invoice's detail panel, the PDF, a statement
    // or a bulk task-status update does. Those pull them through
    // getInvoiceDetails() instead, which keeps the line-pricing permission
    // strip on a path that can enforce it. Dropping them takes the payload to
    // ~264 KB. `items(count)` keeps the "N tasks" badge on each row.
    // Caps at 500 most-recent invoices to bound the payload.
    supabase
      .from('invoices')
      .select(`
        *,
        client:clients(id, name, code, phone, email, address),
        item_count:invoice_items(count),
        payments(id, amount, currency, exchange_rate, amount_inr, payment_date, payment_method, reference, notes),
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
    // EGRESS: shared 5-minute cache. The unfiltered select used to drag the
    // base64 branding blobs across on every render of this page.
    getCompanySettings(),
    supabase
      .from('exchange_rates')
      .select('*'),
    supabase
      .from('cashbook_categories')
      .select('*')
      .order('type')
      .order('name'),
  ])

  // Already a key→value map (getCompanySettings).
  const settings: Record<string, string> = settingsRes

  // Server-side strip: when the user lacks view_amounts and/or view_line_pricing,
  // the corresponding ₹ fields are deleted from the payload BEFORE serialisation
  // so they never appear in the RSC stream, network response, or DevTools state.
  const initialInvoices = stripInvoiceList(
    (invoicesRes.data || []) as any[],
    { amounts: vis.billingAmounts, linePricing: vis.billingLinePricing },
  )

  // Agreement breakdowns: a package fee replaces the task lines it covers, so
  // the covered work has no rows left to render. Rebuilt here (display only) so
  // both the invoice panel and the PDF can show what an agreement included.
  // Three small queries for the whole page — see loadAgreementBreakdowns.
  const serviceNames = new Map(
    (servicesRes.data || []).map((s: { id: string; name: string }) => [s.id, s.name]),
  )
  const agreementBreakdowns = await loadAgreementBreakdowns(
    supabase,
    initialInvoices as any[],
    serviceNames,
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
      agreementBreakdowns={agreementBreakdowns}
      visibility={{
        amounts:     vis.billingAmounts,
        linePricing: vis.billingLinePricing,
      }}
    />
    </>
  )
}
