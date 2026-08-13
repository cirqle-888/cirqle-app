import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { buildAgencyRollups } from '@/lib/integrations/meta/aggregate'
import AgencyClient from './agency-client'

export const dynamic = 'force-dynamic'

const RANGE_DAYS: Record<string, number> = { last7: 7, last30: 30, last90: 90 }

/**
 * Agency master dashboard — every client's social + leads + ads at a glance,
 * agency-wide totals, health, AI insights and configurable alerts.
 * Reuses reports.view (admins bypass) so it sits with the other cross-client BI.
 */
export default async function AgencyDashboardPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const me = await loadCurrentUser().catch(() => null)
  const canView = !me || me.isAdmin || hasPermission(me, [PERMS.REPORTS_VIEW, PERMS.SOCIAL_VIEW_INSIGHTS, PERMS.ADVERTISING_VIEW])
  if (me && !canView) redirect('/dashboard')
  const canManageAlerts = !me || me.isAdmin || hasPermission(me, PERMS.SETTINGS_MANAGE_COMPANY)

  const sp = searchParams ? await searchParams : undefined
  const rangeKey = (typeof sp?.range === 'string' && sp.range in RANGE_DAYS) ? sp.range : 'last30'
  const days = RANGE_DAYS[rangeKey]

  const admin = createAdminClient()
  const [{ rollups, totals }, rulesRes] = await Promise.all([
    buildAgencyRollups(admin, days),
    admin.from('performance_alert_rules').select('*').order('created_at').then((r) => r, () => ({ data: [] as any[] })),
  ])

  return (
    <AgencyClient
      rollups={rollups}
      totals={totals}
      rangeKey={rangeKey}
      rules={(rulesRes.data ?? []) as never[]}
      canManageAlerts={canManageAlerts}
    />
  )
}
