import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadAllAssets } from '@/lib/assets/registry'
import CirqleAccountsClient from './cirqle-accounts-client'

export const dynamic = 'force-dynamic'

/**
 * Cirqle Accounts — the agency's OWN marketing, deliberately separate.
 *
 * Everything here is excluded from client reports, client dashboards, client
 * leads and client billing by the same ownership rule that drives every other
 * surface (@/lib/assets/ownership). This page is the one place those assets
 * are meant to be seen.
 */
export default async function CirqleAccountsPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  if (!(isAdmin || hasPermission(me, PERMS.ASSETS_VIEW_CIRQLE))) redirect('/dashboard')

  const admin = createAdminClient()
  const { assets } = await loadAllAssets(admin)
  const mine = assets.filter(a => a.ownerType === 'cirqle')

  // 30-day rollup for Cirqle's own social accounts only. Same shape as the
  // Social Hub's rollup, scoped by ownership rather than by client.
  const socialIds = mine
    .filter(a => a.kind === 'facebook_page' || a.kind === 'instagram')
    .map(a => a.id)

  let reach = 0, views = 0, interactions = 0
  if (socialIds.length) {
    try {
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
      const { data } = await admin
        .from('social_account_insights_daily')
        .select('reach, views, total_interactions')
        .in('account_id', socialIds)
        .gte('metric_date', since)
      for (const r of (data ?? []) as Record<string, number | null>[]) {
        reach += Number(r.reach ?? 0)
        views += Number(r.views ?? 0)
        interactions += Number(r.total_interactions ?? 0)
      }
    } catch { /* insights not migrated — show zeros rather than failing */ }
  }

  // Leads captured by Cirqle's own forms/pages.
  let leads = 0
  try {
    const { count } = await admin
      .from('leads').select('*', { count: 'exact', head: true }).eq('owner_type', 'cirqle')
    leads = count ?? 0
  } catch { /* pre-migration */ }

  const followers = mine.reduce((s, a) => s + Number(a.followers ?? 0), 0)

  return (
    <CirqleAccountsClient
      assets={mine}
      stats={{ reach, views, interactions, leads, followers }}
    />
  )
}
