import { redirect, notFound } from 'next/navigation'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { financialVisibility } from '@/lib/permissions/strip'
import { PERMS } from '@/lib/permissions/keys'
import { loadAgreementOverview, loadClientMonthProgress } from '@/lib/agreements/server'
import type { AgreementProgressSummary } from '@/lib/agreements/progress'
import { loadRetainerAnalytics, loadRetainerAnalyticsTrend, type RetainerAnalytics, type RetainerTrendPoint } from '@/lib/agreements/analytics'
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
  
  const canViewAgreements = isAdmin || hasPermission(me, PERMS.AGREEMENTS_VIEW)
  const canManageAgreements = isAdmin || hasPermission(me, PERMS.AGREEMENTS_MANAGE)
  const canViewAgreementPricing = isAdmin || hasPermission(me, PERMS.AGREEMENTS_VIEW_PRICING)

  // Overview + this-month progress + retainer analytics — per-client loaders,
  // no N+1. All skipped when the viewer can't see agreements.
  let agreements: Awaited<ReturnType<typeof loadAgreementOverview>> = []
  let agreementProgress: AgreementProgressSummary[] = []
  let retainerAnalytics: RetainerAnalytics[] = []
  let retainerTrend: RetainerTrendPoint[] = []
  if (canViewAgreements) {
    const currentMonth = new Date().toISOString().slice(0, 7)
    const [overview, progress, analytics, trend] = await Promise.all([
      loadAgreementOverview({ clientId: id }).catch(err => {
        console.error('Failed to load agreements', err)
        return []
      }),
      loadClientMonthProgress(id, currentMonth).catch(err => {
        console.error('Failed to load agreement progress', err)
        return [] as AgreementProgressSummary[]
      }),
      loadRetainerAnalytics({ clientId: id, month: currentMonth, pricingVisible: canViewAgreementPricing }).catch(err => {
        console.error('Failed to load retainer analytics', err)
        return [] as RetainerAnalytics[]
      }),
      loadRetainerAnalyticsTrend({ clientId: id, endMonth: currentMonth, months: 6, pricingVisible: canViewAgreementPricing }).catch(() => [] as RetainerTrendPoint[]),
    ])
    agreements = overview
    agreementProgress = progress
    retainerAnalytics = analytics
    retainerTrend = trend
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
      agreementProgress={agreementProgress}
      retainerAnalytics={retainerAnalytics}
      retainerTrend={retainerTrend}
      canViewAgreements={canViewAgreements}
      canManageAgreements={canManageAgreements}
    />
  )
}
