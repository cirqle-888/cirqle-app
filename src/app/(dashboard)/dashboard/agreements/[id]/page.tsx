import { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import {
  loadAgreementItems, loadAgreementEvents, loadClientMonthProgress,
} from '@/lib/agreements/server'
import { stripAgreementItemListPricing } from '@/lib/permissions/strip'
import { loadRetainerAnalytics, type RetainerAnalytics } from '@/lib/agreements/analytics'
import AgreementDetailClient from '../agreement-detail-client'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Agreement Detail | Cirqle',
}

export default async function AgreementDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true
  const canView = isAdmin || hasPermission(me, PERMS.AGREEMENTS_VIEW)
  if (me && !canView) redirect('/dashboard')
  const canManage = isAdmin || hasPermission(me, PERMS.AGREEMENTS_MANAGE)
  const canViewPricing = isAdmin || hasPermission(me, PERMS.AGREEMENTS_VIEW_PRICING)

  const supabase = await createAdminClient()

  const { data: agreement } = await supabase
    .from('client_agreements')
    .select(`*, client:clients(id, name, default_currency)`)
    .eq('id', id)
    .is('deleted_at', null)
    .single()

  if (!agreement) notFound()

  const currentMonth = new Date().toISOString().slice(0, 7)

  const [items, events, progress, servicesRes, analyticsRows] = await Promise.all([
    loadAgreementItems(agreement.id).catch(() => []),
    loadAgreementEvents(agreement.id).catch(() => []),
    loadClientMonthProgress(agreement.client_id, currentMonth).catch(() => []),
    supabase.from('services').select('id, name').eq('is_active', true).order('name'),
    loadRetainerAnalytics({ clientId: agreement.client_id, month: currentMonth, pricingVisible: canViewPricing }).catch(() => [] as RetainerAnalytics[]),
  ])

  const currentProgress = progress.find((p: any) => p.agreementId === agreement.id) || null
  const analytics = analyticsRows.find(a => a.agreementId === agreement.id) || null
  // Never let fees reach a viewer without agreements.view_pricing.
  const safeItems = stripAgreementItemListPricing(items as any[], canViewPricing)

  return (
    <AgreementDetailClient
      agreement={agreement}
      items={safeItems}
      events={events}
      progress={currentProgress}
      analytics={analytics}
      currentMonth={currentMonth}
      services={servicesRes.data || []}
      canManage={canManage}
      canViewPricing={canViewPricing}
    />
  )
}
