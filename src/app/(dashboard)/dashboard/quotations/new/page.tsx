import { createClient } from '@/lib/supabase/server'
import { getCompanySettings } from '@/lib/settings/company-settings'
import QuotationEditor from '../quotation-editor'

export const dynamic = 'force-dynamic'

/** A new quotation, on its own page with the client-facing preview beside it. */
export default async function NewQuotationPage() {
  const supabase = await createClient()
  const [clientsRes, companySettings] = await Promise.all([
    supabase.from('clients').select('id, name, code, phone, email, address').eq('is_active', true).order('name'),
    getCompanySettings(),
  ])
  return <QuotationEditor quotation={null} clients={clientsRes.data || []} companySettings={companySettings} />
}
