import { notFound, redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { loadClientMarketing } from '@/lib/marketing/load'
import { hubIssues } from '@/lib/marketing/hub'
import { todayISO } from '@/lib/utils/local-date'
import { clientAdsPerms, loadClientAds } from '../../advertising/clients/[clientId]/_load'
import { marketingAccess } from '../_access'
import ClientHub from './client-hub'

export const dynamic = 'force-dynamic'

/**
 * Client Marketing Hub — one client's Pages, campaigns, content and leads in
 * one place. Every section comes from its own module's data and keeps that
 * module's permission gate; nothing here is a second copy of the truth.
 */
export default async function ClientMarketingPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) notFound()

  const me = await loadCurrentUser().catch(() => null)
  const access = marketingAccess(me)
  if (me && !access.any) redirect('/dashboard')
  const { view: adsView, ...adsPerms } = clientAdsPerms(me)
  const showAds = access.ads && (!me || adsView)

  const admin = createAdminClient()
  const today = todayISO()
  const [clientRes, clientsRes, withMarketing, hub, ads] = await Promise.all([
    admin.from('clients').select('id, name, code, is_active').eq('id', clientId).maybeSingle(),
    admin.from('clients').select('id, name, code, is_active').order('name'),
    // Which clients have anything marketing-shaped — pinned first in the switcher.
    Promise.all([
      admin.from('social_accounts').select('client_id').neq('status', 'disconnected').then(r => r.data ?? [], () => []),
      admin.from('ad_projects').select('client_id').is('deleted_at', null).then(r => r.data ?? [], () => []),
      admin.from('social_calendars').select('client_id').then(r => r.data ?? [], () => []),
    ]).then(sets => [...new Set((sets.flat() as { client_id: string | null }[]).map(r => r.client_id).filter(Boolean))] as string[]),
    loadClientMarketing(admin, clientId, today, { social: access.social, leads: access.leads, assets: access.assets }),
    showAds ? loadClientAds(clientId, adsPerms) : Promise.resolve(null),
  ])
  const client = clientRes.data
  if (!client) notFound()

  const issues = hubIssues({
    clientId, clientName: client.name,
    accounts: hub.accounts,
    currentPlan: hub.currentPlan ? { id: hub.currentPlan.id, progress: hub.currentPlan.progress } : null,
    expectsPlan: hub.accounts.length > 0 || hub.plans.length > 0,
    overduePlanItems: hub.overduePlanItems,
    failedPosts: hub.failedPosts,
    staleNewLeads: hub.staleNewLeads,
    canSeeSocial: access.social,
    canSeeLeads: access.leads,
    today,
  })

  return (
    <ClientHub
      client={{ id: client.id, name: client.name, code: client.code ?? null, isActive: client.is_active !== false }}
      clients={((clientsRes.data ?? []) as { id: string; name: string; code: string | null; is_active: boolean | null }[]).map(c => ({ id: c.id, name: c.name, code: c.code ?? null, isActive: c.is_active !== false }))}
      withMarketing={withMarketing}
      hub={hub}
      issues={issues}
      ads={ads ? {
        migrated: ads.data.migrated,
        projects: ads.data.projects,
        metricsByProject: ads.data.metricsByProject,
        benchmarksByProject: ads.data.benchmarksByProject,
        attention: ads.data.attention,
        walletSupported: ads.data.walletSupported,
        ledger: ads.data.ledger,
        fundCandidates: ads.data.fundCandidates,
        reports: ads.reports,
        reportPreferences: ads.prefs.byClient,
        reportPreferencesSupported: ads.prefs.supported,
        perms: adsPerms,
        adFunds: ads.adFunds,
      } : null}
      access={access}
      today={today}
    />
  )
}
