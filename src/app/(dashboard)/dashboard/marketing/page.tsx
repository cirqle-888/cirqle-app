import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { loadMarketingDirectory } from '@/lib/marketing/load'
import { todayISO } from '@/lib/utils/local-date'
import { marketingAccess } from './_access'
import MarketingHome from './marketing-home'

export const dynamic = 'force-dynamic'

/**
 * Marketing — start here. Pick a client and everything for them (Pages,
 * campaigns, content, leads) is one click away in their hub.
 */
export default async function MarketingPage() {
  const me = await loadCurrentUser().catch(() => null)
  const access = marketingAccess(me)
  if (me && !access.any) redirect('/dashboard')

  const directory = await loadMarketingDirectory(createAdminClient(), todayISO())

  // Money and lead counts follow their own modules' gates.
  const clients = directory.clients.map(c => ({
    ...c,
    spend30: access.ads ? c.spend30 : 0,
    liveCampaigns: access.ads ? c.liveCampaigns : 0,
    activeCampaigns: access.ads ? c.activeCampaigns : 0,
    leads30: access.leads ? c.leads30 : 0,
    plan: access.social ? c.plan : null,
    hasPlan: access.social ? c.hasPlan : false,
  }))

  return (
    <MarketingHome
      clients={clients}
      unassignedAssets={access.assets ? directory.unassignedAssets : 0}
      cirqleAccounts={access.cirqleAccounts ? directory.cirqleAccounts : 0}
      month={directory.month}
      access={access}
    />
  )
}
