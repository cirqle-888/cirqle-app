import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import QuotationsClient from './quotations-client'
import { QUOTATION_SELECT } from './types'

export const dynamic = 'force-dynamic'

export default async function QuotationsPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  // Links made before quotations had their own page used ?id=<id>.
  const { id } = await searchParams
  if (typeof id === 'string' && id) redirect(`/dashboard/quotations/${encodeURIComponent(id)}`)

  const supabase = await createClient()

  const quotationsRes = await supabase
    .from('quotations')
    .select(QUOTATION_SELECT)
    .order('created_at', { ascending: false })

  return <QuotationsClient initialQuotations={quotationsRes.data || []} />
}
