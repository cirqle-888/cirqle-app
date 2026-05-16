import { createClient } from '@/lib/supabase/server'
import InvoicesClient from './invoices-client'

export const dynamic = 'force-dynamic'

export default async function InvoicesPage() {
  const supabase = await createClient()

  const [invoicesRes, clientsRes, bankRes, servicesRes, settingsRes] = await Promise.all([
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

  return (
    <InvoicesClient
      initialInvoices={(invoicesRes.data || []) as any[]}
      clients={clientsRes.data || []}
      bankAccounts={bankRes.data || []}
      services={servicesRes.data || []}
      companySettings={settings}
    />
  )
}
