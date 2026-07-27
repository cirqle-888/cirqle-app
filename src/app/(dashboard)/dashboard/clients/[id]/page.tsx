import { redirect, notFound } from 'next/navigation'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { financialVisibility } from '@/lib/permissions/strip'
import { PERMS } from '@/lib/permissions/keys'
import { loadAgreementOverview } from '@/lib/agreements/server'
import ClientDetailClient from './client-detail-client'

export const dynamic = 'force-dynamic'

/** Per-client dashboard — KPIs, invoices, tasks, pricing, contact details. */
export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true
  const canView = isAdmin || me?.permissions.has(PERMS.CLIENTS_VIEW) || !me
  if (me && !canView) redirect('/dashboard')

  const vis = financialVisibility(me)
  const showAmounts = isAdmin || vis.billingAmounts

  const supabase = createAdminClient()

  const { data: client } = await supabase.from('clients').select('*').eq('id', id).maybeSingle()
  if (!client) notFound()

  const [invoicesRes, tasksRes, pricingRes, servicesRes, partnerRes] = await Promise.all([
    showAmounts
      ? fetchAll(supabase.from('invoices')
          .select('id, invoice_number, status, total_amount, paid_amount, issue_date, due_date, created_at')
          .eq('client_id', id).order('created_at', { ascending: false }))
      : Promise.resolve({ data: [] as any[] }),
    supabase.from('tasks')
      .select('id, task_number, title, status, task_date, service:services(id, name)')
      .eq('client_id', id).is('deleted_at', null)
      .order('task_date', { ascending: false }).limit(400),
    supabase.from('client_service_pricing').select('service_id, price, commission_percentage, currency').eq('client_id', id),
    supabase.from('services').select('id, name, is_active').order('name'),
    client.business_partner_id
      ? supabase.from('business_partners').select('id, name, partner_code').eq('id', client.business_partner_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  
  let agreements: any[] = []
  try {
    agreements = await loadAgreementOverview({ clientId: id })
  } catch (err) {
    console.error('Failed to load agreements', err)
  }

  return (
    <ClientDetailClient
      client={client}
      invoices={(invoicesRes.data || []) as any[]}
      tasks={(tasksRes.data || []) as any[]}
      pricing={(pricingRes.data || []) as any[]}
      services={(servicesRes.data || []) as any[]}
      partner={partnerRes.data as any}
      showAmounts={showAmounts}
      agreements={agreements}
    />
  )
}
