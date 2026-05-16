import { createClient } from '@/lib/supabase/server'
import QuotationsClient from './quotations-client'

export default async function QuotationsPage() {
  const supabase = await createClient()

  const [quotationsRes, clientsRes] = await Promise.all([
    supabase
      .from('quotations')
      .select(`
        *,
        client:clients(id, name, code),
        items:quotation_items(*)
      `)
      .order('created_at', { ascending: false }),
    supabase.from('clients').select('id, name, code').eq('is_active', true).order('name'),
  ])

  return (
    <QuotationsClient
      initialQuotations={quotationsRes.data || []}
      clients={clientsRes.data || []}
    />
  )
}
