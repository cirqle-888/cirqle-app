import { redirect } from 'next/navigation'
import { createAdminClient, columnExists } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import SocialClient from './social-client'
import type { SocialAccountRow } from './social-client'
import { toISODate } from '@/lib/utils/local-date'

export const dynamic = 'force-dynamic'

/**
 * Social Hub landing — every connected FB Page / IG account across all
 * clients, with 30-day rollups and health at a glance.
 *
 * SECURITY: social_accounts.access_token is never selected here.
 */
export default async function SocialHubPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const me = await loadCurrentUser().catch(() => null)
  // Fail-open when no employee record yet (pre-migration), like other pages.
  const canView = !me || hasPermission(me, [PERMS.SOCIAL_VIEW_INSIGHTS, PERMS.SOCIAL_CONNECT])
  if (me && !canView) redirect('/dashboard')
  const canConnect = !me || hasPermission(me, PERMS.SOCIAL_CONNECT)
  const canViewInsights = !me || hasPermission(me, PERMS.SOCIAL_VIEW_INSIGHTS)

  const sp = searchParams ? await searchParams : undefined
  const oauthSuccess = typeof sp?.success === 'string' ? sp.success : undefined
  const oauthError = typeof sp?.error === 'string' ? sp.error : undefined

  const admin = createAdminClient()

  // Client-owned only — Cirqle's own assets have their own page, and untriaged
  // ones belong on Asset Assignment until someone decides. Probed rather than
  // assumed so this file is safe to deploy BEFORE the ownership migration runs;
  // without the column every account is client-owned, exactly as before.
  const hasOwnerType = await columnExists(admin, 'social_accounts', 'owner_type')

  const since = new Date()
  since.setDate(since.getDate() - 30)
  const sinceStr =toISODate( since)

  const weekEnd = new Date()
  weekEnd.setDate(weekEnd.getDate() + 7)

  const [accountsRes, insightsRes, postsRes, clientsRes] = await Promise.all([
    admin
      .from('social_accounts')
      .select(`
        id, client_id, owner_type, connection_id, platform, external_id, name, username,
        profile_picture_url, followers_count, status, publishing_enabled,
        insights_enabled, last_synced_at, last_error,
        client:clients(name)
      `)
      .order('created_at', { ascending: true })
      .limit(500)
      .then(r => hasOwnerType
        ? { ...r, data: (r.data ?? []).filter((a: { owner_type?: string }) => (a.owner_type ?? 'client') === 'client') }
        : r),
    admin
      .from('social_account_insights_daily')
      .select('account_id, reach, views, total_interactions')
      .gte('metric_date', sinceStr)
      .limit(20000),
    admin
      .from('social_posts')
      .select('account_id, status, scheduled_at')
      .in('status', ['scheduled', 'failed'])
      .is('deleted_at', null)
      .limit(5000),
    admin
      .from('clients')
      .select('id, name')
      .eq('is_active', true)
      .order('name')
      .limit(1000),
  ])

  // Per-account 30-day rollups (sum reach / views / interactions in JS —
  // row counts are small: ≤30 days × accounts).
  const rollups = new Map<string, { reach: number; views: number; interactions: number }>()
  for (const r of insightsRes.data ?? []) {
    const cur = rollups.get(r.account_id) ?? { reach: 0, views: 0, interactions: 0 }
    cur.reach += Number(r.reach ?? 0)
    cur.views += Number(r.views ?? 0)
    cur.interactions += Number(r.total_interactions ?? 0)
    rollups.set(r.account_id, cur)
  }

  const now = Date.now()
  const postCounts = new Map<string, { scheduled: number; failed: number }>()
  let scheduledThisWeek = 0
  let failedTotal = 0
  for (const p of postsRes.data ?? []) {
    const cur = postCounts.get(p.account_id) ?? { scheduled: 0, failed: 0 }
    if (p.status === 'scheduled') {
      cur.scheduled += 1
      if (p.scheduled_at) {
        const t = new Date(p.scheduled_at).getTime()
        if (t >= now - 24 * 3600_000 && t <= weekEnd.getTime()) scheduledThisWeek += 1
      }
    } else if (p.status === 'failed') {
      cur.failed += 1
      failedTotal += 1
    }
    postCounts.set(p.account_id, cur)
  }

  const accounts: SocialAccountRow[] = (accountsRes.data ?? []).map((a: any) => {
    const client = Array.isArray(a.client) ? a.client[0] : a.client
    const roll = rollups.get(a.id)
    const posts = postCounts.get(a.id)
    return {
      id: a.id,
      client_id: a.client_id,
      connection_id: a.connection_id,
      platform: a.platform,
      external_id: a.external_id,
      name: a.name,
      username: a.username,
      profile_picture_url: a.profile_picture_url,
      followers_count: a.followers_count,
      status: a.status,
      publishing_enabled: a.publishing_enabled,
      insights_enabled: a.insights_enabled,
      last_synced_at: a.last_synced_at,
      last_error: a.last_error,
      client_name: client?.name ?? '—',
      reach30: roll?.reach ?? 0,
      views30: roll?.views ?? 0,
      interactions30: roll?.interactions ?? 0,
      scheduled_count: posts?.scheduled ?? 0,
      failed_count: posts?.failed ?? 0,
    }
  })

  return (
    <SocialClient
      accounts={accounts}
      clients={(clientsRes.data ?? []) as { id: string; name: string }[]}
      canConnect={canConnect}
      canViewInsights={canViewInsights}
      scheduledThisWeek={scheduledThisWeek}
      failedTotal={failedTotal}
      oauthSuccess={oauthSuccess}
      oauthError={oauthError}
    />
  )
}
