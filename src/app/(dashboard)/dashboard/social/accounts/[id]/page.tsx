import { notFound, redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import AccountDashboardClient from './account-dashboard-client'
import { toISODate } from '@/lib/utils/local-date'

export const dynamic = 'force-dynamic'

const RANGE_DAYS: Record<string, number> = {
  last7: 7, last30: 30, last90: 90,
}

/**
 * Per-account social dashboard — KPI cards with previous-period comparison,
 * reach/views + follower trends, and top content. Reads only Cirqle's
 * normalized social tables (never the Meta API, never the token column).
 */
export default async function SocialAccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  const me = await loadCurrentUser().catch(() => null)
  if (me && !hasPermission(me, PERMS.SOCIAL_VIEW_INSIGHTS)) redirect('/dashboard')

  const sp = searchParams ? await searchParams : undefined
  const rangeKey = (typeof sp?.range === 'string' && sp.range in RANGE_DAYS) ? sp.range : 'last30'
  const days = RANGE_DAYS[rangeKey]

  const admin = createAdminClient()

  const { data: account } = await admin
    .from('social_accounts')
    .select(`
      id, client_id, platform, external_id, name, username, profile_picture_url,
      followers_count, status, last_synced_at, last_error, publishing_enabled,
      insights_enabled, client:clients(name)
    `)
    .eq('id', id)
    .maybeSingle()

  if (!account) notFound()
  const client = Array.isArray(account.client) ? account.client[0] : account.client

  const now = new Date()
  const curFrom = new Date(now.getTime() - days * 24 * 60 * 60_000)
  const prevFrom = new Date(now.getTime() - 2 * days * 24 * 60 * 60_000)
  const fmt = (d: Date) =>toISODate( d)

  const [dailyRes, mediaRes] = await Promise.all([
    admin
      .from('social_account_insights_daily')
      .select('metric_date, followers_count, follows, reach, views, total_interactions, accounts_engaged, profile_links_taps, page_views')
      .eq('account_id', id)
      .gte('metric_date', fmt(prevFrom))
      .order('metric_date', { ascending: true }),
    admin
      .from('social_media_items')
      .select('id, external_media_id, media_type, media_product_type, caption, permalink, thumbnail_url, posted_at, is_story, views, reach, likes, comments, shares, saves, total_interactions, engagement_rate')
      .eq('account_id', id)
      .order('posted_at', { ascending: false })
      .limit(200),
  ])

  const daily = (dailyRes.data ?? []) as Array<Record<string, number | string | null>>
  const curCut = fmt(curFrom)

  // Sum a numeric column over the current vs previous window.
  const sums = (col: string) => {
    let cur = 0, prev = 0
    for (const row of daily) {
      const d = String(row.metric_date)
      const v = Number(row[col] ?? 0)
      if (d >= curCut) cur += v
      else prev += v
    }
    return { cur, prev }
  }

  const reach = sums('reach')
  const views = sums('views')
  const interactions = sums('total_interactions')
  const profileTaps = sums('profile_links_taps')
  const pageViews = sums('page_views')

  // Followers: latest snapshot in each window (not a sum)
  const latestFollowers = (fromCut: string, toCutExclusive?: string) => {
    let val: number | null = null
    for (const row of daily) {
      const d = String(row.metric_date)
      if (d < fromCut) continue
      if (toCutExclusive && d >= toCutExclusive) continue
      if (row.followers_count != null) val = Number(row.followers_count)
    }
    return val
  }
  const followersNow = account.followers_count ?? latestFollowers(curCut) ?? null
  const followersPrev = latestFollowers(fmt(prevFrom), curCut)

  // Daily series for charts (current window only)
  const series = daily
    .filter((r) => String(r.metric_date) >= curCut)
    .map((r) => ({
      date: String(r.metric_date),
      reach: Number(r.reach ?? 0),
      views: Number(r.views ?? 0),
      interactions: Number(r.total_interactions ?? 0),
      followers: r.followers_count != null ? Number(r.followers_count) : null,
    }))

  const media = (mediaRes.data ?? []).map((m: any) => ({
    id: m.id,
    external_media_id: m.external_media_id,
    media_product_type: m.media_product_type,
    caption: m.caption,
    permalink: m.permalink,
    thumbnail_url: m.thumbnail_url,
    posted_at: m.posted_at,
    is_story: m.is_story,
    views: m.views,
    reach: m.reach,
    likes: m.likes,
    comments: m.comments,
    shares: m.shares,
    saves: m.saves,
    total_interactions: m.total_interactions,
    engagement_rate: m.engagement_rate,
  }))

  return (
    <AccountDashboardClient
      account={{
        id: account.id,
        client_id: account.client_id,
        platform: account.platform,
        name: account.name,
        username: account.username,
        profile_picture_url: account.profile_picture_url,
        status: account.status,
        last_synced_at: account.last_synced_at,
        last_error: account.last_error,
        client_name: client?.name ?? '—',
      }}
      rangeKey={rangeKey}
      days={days}
      kpis={{
        followersNow, followersPrev,
        reach, views, interactions, profileTaps, pageViews,
      }}
      series={series}
      media={media}
    />
  )
}
