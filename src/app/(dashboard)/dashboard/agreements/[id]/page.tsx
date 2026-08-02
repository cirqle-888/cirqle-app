import { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import {
  loadAgreementItems, loadAgreementEvents, loadClientMonthProgress,
} from '@/lib/agreements/server'
import { stripAgreementItemListPricing } from '@/lib/permissions/strip'
import AgreementDetailClient from '../agreement-detail-client'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Agreement Detail | Cirqle',
}

/** 'YYYY-MM' or null. Guards against a hand-edited ?month= reaching the query. */
function parseMonth(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw
  return v && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : null
}

export default async function AgreementDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ month?: string }>
}) {
  const { id } = await params
  const { month: monthParam } = await searchParams
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
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

  const currentMonth = parseMonth(monthParam) ?? new Date().toISOString().slice(0, 7)

  const [items, events, progress, servicesRes] = await Promise.all([
    loadAgreementItems(agreement.id).catch(() => []),
    loadAgreementEvents(agreement.id).catch(() => []),
    loadClientMonthProgress(agreement.client_id, currentMonth).catch(() => []),
    supabase.from('services').select('id, name').eq('is_active', true).order('name'),
  ])

  const currentProgress = progress.find((p: any) => p.agreementId === agreement.id) || null
  // Never let fees reach a viewer without agreements.view_pricing.
  const safeItems = stripAgreementItemListPricing(items as any[], canViewPricing)

  return (
    <AgreementDetailClient
      agreement={agreement}
      items={safeItems}
      events={events}
      progress={currentProgress}
      currentMonth={currentMonth}
      services={servicesRes.data || []}
      canManage={canManage}
      canViewPricing={canViewPricing}
    />
  )
}
