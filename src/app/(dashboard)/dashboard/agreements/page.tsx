import { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadAgreementOverview } from '@/lib/agreements/server'
import { loadRetainerAnalytics, type RetainerAnalytics } from '@/lib/agreements/analytics'
import AgreementsListClient from './agreements-list-client'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Client Agreements | Cirqle',
}

export default async function AgreementsPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canView = isAdmin || hasPermission(me, PERMS.AGREEMENTS_VIEW)
  if (me && !canView) redirect('/dashboard')
  const canManage = isAdmin || hasPermission(me, PERMS.AGREEMENTS_MANAGE)
  const canViewPricing = isAdmin || hasPermission(me, PERMS.AGREEMENTS_VIEW_PRICING)

  // Defensive read — the module tolerates an un-applied migration (design §9.2).
  let agreements: any[] = []
  let errorMsg: string | null = null
  let clients: { id: string; name: string; code: string }[] = []
  let analytics: RetainerAnalytics[] = []

  try {
    const currentMonth = new Date().toISOString().slice(0, 7)
    const admin = await createAdminClient()
    const [overview, clientsRes, analyticsRes] = await Promise.all([
      loadAgreementOverview({}),
      admin.from('clients').select('id, name, code').eq('is_active', true).order('name'),
      loadRetainerAnalytics({ month: currentMonth, pricingVisible: canViewPricing }).catch(() => [] as RetainerAnalytics[]),
    ])
    agreements = overview
    clients = clientsRes.data || []
    analytics = analyticsRes
  } catch (err) {
    console.error('Failed to load agreements', err)
    errorMsg = 'Agreements module is not fully initialized. Please ensure migrations are applied.'
  }

  return (
    <AgreementsListClient
      initialAgreements={agreements}
      clients={clients}
      analytics={analytics}
      canManage={canManage}
      canViewPricing={canViewPricing}
      errorMsg={errorMsg}
    />
  )
}
