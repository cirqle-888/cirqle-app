import { redirect } from 'next/navigation'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { fetchActiveClients } from '../../actions'
import { fetchMappingAccount, fetchAccountCampaigns } from '../../mapping-actions'
import { CampaignMappingClient } from './campaign-mapping-client'

export const metadata = { title: 'Map Campaigns' }
export const dynamic = 'force-dynamic'

export default async function CampaignMappingPage({
  params,
}: {
  params: Promise<{ accountId: string }>
}) {
  const { accountId } = await params

  const user = await loadCurrentUser()
  if (!user || (!user.isAdmin && !hasPermission(user, PERMS.ADVERTISING_MAP_CAMPAIGNS))) {
    redirect('/dashboard?error=unauthorized')
  }

  // Defensive: pre-migration (no ad_campaigns table) the reads throw — render an
  // empty state with a "run migration" hint instead of crashing.
  let account: any = null
  let campaigns: any[] = []
  let clients: { id: string; name: string }[] = []
  let notReady = false
  try {
    ;[account, campaigns, clients] = await Promise.all([
      fetchMappingAccount(accountId),
      fetchAccountCampaigns(accountId),
      fetchActiveClients(),
    ])
  } catch {
    notReady = true
  }

  return (
    <div className="flex flex-col gap-6 w-full p-6">
      <CampaignMappingClient
        accountId={accountId}
        account={account}
        initialCampaigns={campaigns}
        clients={clients}
        notReady={notReady}
      />
    </div>
  )
}
