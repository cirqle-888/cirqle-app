import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { getPartner, getPartnerDashboard, listUnlinkedClients, listCommissionPayments } from '@/lib/partners/queries'
import PartnerDashboardClient from './partner-dashboard-client'

export const dynamic = 'force-dynamic'

export default async function PartnerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const me = await loadCurrentUser().catch(() => null)

  const partner = await getPartner(id)
  if (!partner) notFound()

  const [dashboard, unlinkedClients, settingsRes, commissionPayments] = await Promise.all([
    getPartnerDashboard(id),
    listUnlinkedClients(),
    createAdminClient().from('company_settings').select('key, value'),
    listCommissionPayments(id),
  ])

  const settings: Record<string, string> = {}
  ;(settingsRes.data || []).forEach((s: { key: string; value: string }) => { settings[s.key] = s.value })

  return (
    <PartnerDashboardClient
      partner={partner}
      dashboard={dashboard}
      unlinkedClients={unlinkedClients}
      commissionPayments={commissionPayments}
      brand={{
        companyName: settings.company_name || 'Cirqle CRM',
        primaryColor: settings.invoice_primary_color || '#1a2744',
      }}
      canEdit={hasPermission(me, PERMS.PARTNERS_EDIT)}
      canExport={hasPermission(me, PERMS.PARTNERS_EXPORT)}
      // Margin exposes our costs and staff commissions, so it rides on the
      // reports permission rather than plain partner access.
      canViewProfit={hasPermission(me, PERMS.REPORTS_VIEW)}
    />
  )
}
