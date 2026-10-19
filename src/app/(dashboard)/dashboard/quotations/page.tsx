import { createClient } from '@/lib/supabase/server'
import { getCompanySettings } from '@/lib/settings/company-settings'
import QuotationsClient from './quotations-client'

export const dynamic = 'force-dynamic'

export default async function QuotationsPage() {
  const supabase = await createClient()

  const [quotationsRes, clientsRes, companySettings] = await Promise.all([
    supabase
      .from('quotations')
      .select(`
        *,
        client:clients(id, name, code, phone, email, address),
        items:quotation_items(*)
      `)
      .order('created_at', { ascending: false }),
    supabase.from('clients').select('id, name, code').eq('is_active', true).order('name'),
    // Branding for the client-facing preview / PDF, the same cached read the
    // Invoices page uses.
    getCompanySettings(),
  ])

  return (
    <QuotationsClient
      initialQuotations={quotationsRes.data || []}
      clients={clientsRes.data || []}
      companySettings={companySettings}
    />
  )
}
