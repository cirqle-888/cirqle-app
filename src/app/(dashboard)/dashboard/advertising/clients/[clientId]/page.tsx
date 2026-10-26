import { notFound, redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import ClientWorkspace from './client-workspace'
import { clientAdsPerms, loadClientAds } from './_load'

export const dynamic = 'force-dynamic'

/**
 * Client workspace (plan Phase 3): one client's advertising in four tabs —
 * Overview · Campaigns · Funds & billing · Reports. Same data and the same
 * permission gating as the overview (loadAdvertisingData), filtered to the
 * client. The Client Marketing Hub's Ads tab renders this same workspace.
 */
export default async function ClientWorkspacePage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) notFound()

  const me = await loadCurrentUser().catch(() => null)
  const { view, ...perms } = clientAdsPerms(me)
  if (me && !view) redirect('/dashboard')

  const admin = createAdminClient()
  const { data: client } = await admin.from('clients').select('id, name, code').eq('id', clientId).maybeSingle()
  if (!client) notFound()

  const { data, reports, prefs } = await loadClientAds(clientId, perms)

  return (
    <ClientWorkspace
      client={client}
      migrated={data.migrated}
      projects={data.projects}
      metricsByProject={data.metricsByProject}
      benchmarksByProject={data.benchmarksByProject}
      attention={data.attention}
      walletSupported={data.walletSupported}
      ledger={data.ledger}
      fundCandidates={data.fundCandidates}
      reports={reports}
      reportPreferences={prefs.byClient}
      reportPreferencesSupported={prefs.supported}
      perms={perms}
    />
  )
}
