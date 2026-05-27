import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { financialVisibility, stripInvoiceList } from '@/lib/permissions/strip'
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

  const [invoicesRes, clientsRes, bankRes, servicesRes, settingsRes] = await Promise.all([
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
        payments(id, amount, payment_date, payment_method, reference, notes)
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
      .select('id, name')
      .eq('is_active', true),
    supabase
      .from('services')
      .select('id, name')
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('company_settings')
      .select('key, value'),
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

  return (
    <InvoicesClient
      initialInvoices={initialInvoices}
      clients={clientsRes.data || []}
      bankAccounts={bankRes.data || []}
      services={servicesRes.data || []}
      companySettings={settings}
      visibility={{
        amounts:     vis.billingAmounts,
        linePricing: vis.billingLinePricing,
      }}
    />
  )
}
