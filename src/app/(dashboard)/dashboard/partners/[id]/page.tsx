import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { getPartner, getPartnerDashboard, listUnlinkedClients, listCommissionPayments } from '@/lib/partners/queries'
import { getCompanySettings } from '@/lib/settings/company-settings'
import PartnerDashboardClient from './partner-dashboard-client'

export const dynamic = 'force-dynamic'

export default async function PartnerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const me = await loadCurrentUser().catch(() => null)

  const partner = await getPartner(id)
  if (!partner) notFound()

  let initialGreetingName = ''
  if (me?.employeeId) {
    try {
      const { data } = await createAdminClient()
        .from('employee_partner_preferences')
        .select('greeting_name')
        .eq('employee_id', me.employeeId)
        .eq('business_partner_id', id)
        .maybeSingle()
      if (data?.greeting_name) initialGreetingName = data.greeting_name
    } catch { /* ignore */ }
  }

  // EGRESS: getCompanySettings() is a shared 5-minute cache. This page only
  // needs two branding strings, but the old unfiltered select pulled every row
  // — including the base64 logo blobs — on each render.
  const [dashboard, unlinkedClients, settings, commissionPayments] = await Promise.all([
    getPartnerDashboard(id),
    listUnlinkedClients(),
    getCompanySettings(),
    listCommissionPayments(id),
  ])

  return (
    <PartnerDashboardClient
      partner={partner}
      dashboard={dashboard}
      unlinkedClients={unlinkedClients}
      commissionPayments={commissionPayments}
      initialGreetingName={initialGreetingName}
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
