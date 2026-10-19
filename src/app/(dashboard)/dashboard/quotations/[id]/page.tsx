import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getCompanySettings } from '@/lib/settings/company-settings'
import QuotationEditor from '../quotation-editor'
import { QUOTATION_SELECT } from '../types'

export const dynamic = 'force-dynamic'

/** One quotation: edit it (draft / sent) or read it, with the client-facing preview. */
export default async function QuotationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const [quotationRes, clientsRes, companySettings] = await Promise.all([
    supabase.from('quotations').select(QUOTATION_SELECT).eq('id', id).maybeSingle(),
    supabase.from('clients').select('id, name, code, phone, email, address').eq('is_active', true).order('name'),
    getCompanySettings(),
  ])
  if (!quotationRes.data) notFound()
  return (
    <QuotationEditor
      // Remount on navigation between quotations so no form state carries over.
      key={id}
      quotation={quotationRes.data}
      clients={clientsRes.data || []}
      companySettings={companySettings}
    />
  )
}
