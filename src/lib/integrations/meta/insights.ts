/**
 * Meta insights sync — Facebook Page + Instagram professional accounts.
 *
 * Writes ONLY into Cirqle's normalized tables (social_account_insights_daily,
 * social_media_items); the UI never touches Meta response shapes (spec §22).
 *
 * Metric names follow the 2025/2026 Meta metric reset:
 *  - `views` is the canonical consumption metric (impressions/plays are dead)
 *  - FB: page_media_view family replaced page_impressions*; page_fans is dead
 *    (page_follows / page_daily_follows_unique instead)
 *  - IG account: views, reach, total_interactions, accounts_engaged,
 *    profile_links_taps, follower_count
 *  - IG media: views, reach, likes, comments, shares, saved, total_interactions
 *
 * Every metric group is fetched defensively — Meta keeps pruning metrics, and
 * a removed metric fails the whole request, so groups degrade independently.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { metaGraph, metaGraphAll, MetaApiError, redactTokens } from './client'
import { decryptToken } from '@/lib/integrations/tokens'
import { toISODate } from '@/lib/utils/local-date'

export interface SyncAccountResult {
  ok: boolean
  dailyRows: number
  mediaItems: number
  errors: string[]
}

function isoDate(d: Date): string {
  return toISODate(d)
}

/** Resolve the API token for a social account row (page token → connection user token). */
async function resolveAccountToken(admin: SupabaseClient, account: any): Promise<string | null> {
  // IG accounts authenticate through their linked Page's token when present.
  if (account.platform === 'instagram' && account.linked_page_account_id) {
    const { data: page } = await admin
      .from('social_accounts')
      .select('access_token')
      .eq('id', account.linked_page_account_id)
      .maybeSingle()
    const pageToken = decryptToken(page?.access_token)
    if (pageToken) return pageToken
  }
  const own = decryptToken(account.access_token)
  if (own) return own
  if (account.connection_id) {
    const { data: conn } = await admin
      .from('provider_connections')
      .select('access_token, status')
      .eq('id', account.connection_id)
      .maybeSingle()
    if (conn?.status === 'active') return decryptToken(conn.access_token)
  }
  return null
}

/** Mark auth failures on the account so the health UI can surface reauth. */
async function flagAuthError(admin: SupabaseClient, accountId: string, err: unknown) {
  if (err instanceof MetaApiError && err.isAuthError) {
    await admin
      .from('social_accounts')
      .update({ status: 'needs_reauth', last_error: redactTokens(err.message) })
      .eq('id', accountId)
      .then(null, () => {})
    return true
  }
  return false
}

// ── Facebook Page ────────────────────────────────────────────────────────────

const FB_DAILY_METRICS: Array<{ metric: string; column: string }> = [
  { metric: 'page_media_view', column: 'views' },
  { metric: 'page_total_media_view_unique', column: 'reach' },
  { metric: 'page_post_engagements', column: 'total_interactions' },
  { metric: 'page_daily_follows_unique', column: 'follows' },
  { metric: 'page_daily_unfollows_unique', column: 'unfollows' },
  { metric: 'page_views_total', column: 'page_views' },
]

async function syncFacebookPageInsights(
  admin: SupabaseClient,
  account: any,
  token: string,
  days: number,
  errors: string[],
): Promise<number> {
  const until = new Date()
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  // Accumulate per-date column values.
  const byDate = new Map<string, Record<string, number>>()

  // Fetch metrics in one call; if the batch fails (a metric got deprecated),
  // retry metric-by-metric so one dead name doesn't zero the whole sync.
  const fetchMetrics = async (metrics: Array<{ metric: string; column: string }>) => {
    const res = await metaGraph<{ data?: any[] }>(`${account.external_id}/insights`, {
      token,
      params: {
        metric: metrics.map((m) => m.metric).join(','),
        period: 'day',
        since: isoDate(since),
        until: isoDate(until),
      },
    })
    for (const series of res.data ?? []) {
      const def = metrics.find((m) => m.metric === series.name)
      if (!def) continue
      for (const point of series.values ?? []) {
        const date = String(point.end_time ?? '').split('T')[0]
        if (!date) continue
        const row = byDate.get(date) ?? {}
        row[def.column] = Number(point.value ?? 0)
        byDate.set(date, row)
      }
    }
  }

  try {
    await fetchMetrics(FB_DAILY_METRICS)
  } catch {
    for (const m of FB_DAILY_METRICS) {
      try {
        await fetchMetrics([m])
      } catch (err: any) {
        errors.push(`FB metric ${m.metric}: ${redactTokens(err?.message)}`)
      }
    }
  }

  // Follower snapshot
  let followers: number | null = null
  try {
    const page = await metaGraph<{ followers_count?: number }>(`${account.external_id}`, {
      token,
      params: { fields: 'followers_count' },
    })
    followers = page.followers_count ?? null
    if (followers !== null) {
      await admin.from('social_accounts').update({ followers_count: followers }).eq('id', account.id)
    }
  } catch (err: any) {
    errors.push(`FB followers: ${redactTokens(err?.message)}`)
  }

  const today = isoDate(new Date())
  let written = 0
  for (const [date, cols] of byDate) {
    const { error } = await admin.from('social_account_insights_daily').upsert(
      {
        account_id: account.id,
        metric_date: date,
        ...cols,
        ...(date === today && followers !== null ? { followers_count: followers } : {}),
        raw: cols,
      },
      { onConflict: 'account_id,metric_date' },
    )
    if (error) errors.push(`FB daily ${date}: ${error.message}`)
    else written++
  }
  return written
}

async function syncFacebookPagePosts(
  admin: SupabaseClient,
  account: any,
  token: string,
  errors: string[],
): Promise<number> {
  let posts: any[] = []
  try {
    posts = await metaGraphAll<any>(`${account.external_id}/published_posts`, {
      token,
      params: {
        fields:
          'id,message,created_time,permalink_url,full_picture,status_type,' +
          'shares,likes.summary(true).limit(0),comments.summary(true).limit(0)',
        limit: 25,
      },
      maxPages: 2,
    })
  } catch (err: any) {
    errors.push(`FB posts: ${redactTokens(err?.message)}`)
    return 0
  }

  let written = 0
  for (const post of posts) {
    const likes = post.likes?.summary?.total_count ?? null
    const comments = post.comments?.summary?.total_count ?? null
    const shares = post.shares?.count ?? null

    // Per-post media views (post_media_view family) — best-effort.
    let views: number | null = null
    let reach: number | null = null
    try {
      const ins = await metaGraph<{ data?: any[] }>(`${post.id}/insights`, {
        token,
        params: { metric: 'post_media_view,post_total_media_view_unique' },
        retries: 1,
      })
      for (const series of ins.data ?? []) {
        const value = Number(series.values?.[0]?.value ?? 0)
        if (series.name === 'post_media_view') views = value
        if (series.name === 'post_total_media_view_unique') reach = value
      }
    } catch {
      /* metric availability varies — keep counts from the post object */
    }

    const totalInteractions = (likes ?? 0) + (comments ?? 0) + (shares ?? 0)
    const { error } = await admin.from('social_media_items').upsert(
      {
        account_id: account.id,
        external_media_id: post.id,
        media_type: post.status_type ?? null,
        media_product_type: 'FEED',
        caption: post.message ?? null,
        permalink: post.permalink_url ?? null,
        thumbnail_url: post.full_picture ?? null,
        posted_at: post.created_time ?? null,
        views,
        reach,
        likes,
        comments,
        shares,
        total_interactions: totalInteractions,
        engagement_rate: reach && reach > 0 ? Number(((totalInteractions / reach) * 100).toFixed(4)) : null,
        raw_insights: { likes, comments, shares, views, reach },
        last_insights_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,external_media_id' },
    )
    if (error) errors.push(`FB post ${post.id}: ${error.message}`)
    else written++
  }
  return written
}

// ── Instagram ────────────────────────────────────────────────────────────────

async function syncInstagramAccountInsights(
  admin: SupabaseClient,
  account: any,
  token: string,
  days: number,
  errors: string[],
): Promise<number> {
  const until = new Date()
  const since = new Date(Date.now() - Math.min(days, 30) * 24 * 60 * 60 * 1000) // IG day series max ~30d

  const byDate = new Map<string, Record<string, number>>()

  // Time-series metrics (per-day values)
  const seriesMetrics: Array<{ metric: string; column: string }> = [
    { metric: 'views', column: 'views' },
    { metric: 'reach', column: 'reach' },
    { metric: 'follower_count', column: 'follows' },
  ]
  for (const m of seriesMetrics) {
    try {
      const res = await metaGraph<{ data?: any[] }>(`${account.external_id}/insights`, {
        token,
        params: {
          metric: m.metric,
          period: 'day',
          metric_type: 'time_series',
          since: Math.floor(since.getTime() / 1000),
          until: Math.floor(until.getTime() / 1000),
        },
        retries: 1,
      })
      for (const series of res.data ?? []) {
        for (const point of series.values ?? []) {
          const date = String(point.end_time ?? '').split('T')[0]
          if (!date) continue
          const row = byDate.get(date) ?? {}
          row[m.column] = Number(point.value ?? 0)
          byDate.set(date, row)
        }
      }
    } catch (err: any) {
      errors.push(`IG metric ${m.metric}: ${redactTokens(err?.message)}`)
    }
  }

  // Total-value metrics for YESTERDAY (a daily sync fills each day as it passes)
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const totalMetrics: Array<{ metric: string; column: string }> = [
    { metric: 'total_interactions', column: 'total_interactions' },
    { metric: 'accounts_engaged', column: 'accounts_engaged' },
    { metric: 'profile_links_taps', column: 'profile_links_taps' },
  ]
  try {
    const res = await metaGraph<{ data?: any[] }>(`${account.external_id}/insights`, {
      token,
      params: {
        metric: totalMetrics.map((m) => m.metric).join(','),
        period: 'day',
        metric_type: 'total_value',
        since: Math.floor(yesterday.setHours(0, 0, 0, 0) / 1000),
        until: Math.floor(new Date().setHours(0, 0, 0, 0) / 1000),
      },
      retries: 1,
    })
    const ydate = isoDate(new Date(Date.now() - 24 * 60 * 60 * 1000))
    for (const series of res.data ?? []) {
      const def = totalMetrics.find((m) => m.metric === series.name)
      if (!def) continue
      const row = byDate.get(ydate) ?? {}
      row[def.column] = Number(series.total_value?.value ?? 0)
      byDate.set(ydate, row)
    }
  } catch (err: any) {
    errors.push(`IG total_value metrics: ${redactTokens(err?.message)}`)
  }

  // Follower snapshot + profile refresh
  let followers: number | null = null
  try {
    const profile = await metaGraph<any>(`${account.external_id}`, {
      token,
      params: { fields: 'followers_count,username,name,profile_picture_url,media_count' },
    })
    followers = profile.followers_count ?? null
    await admin
      .from('social_accounts')
      .update({
        followers_count: followers,
        username: profile.username ?? account.username,
        name: profile.name ?? account.name,
        profile_picture_url: profile.profile_picture_url ?? account.profile_picture_url,
        metadata: { ...(account.metadata ?? {}), media_count: profile.media_count ?? null },
      })
      .eq('id', account.id)
  } catch (err: any) {
    errors.push(`IG profile: ${redactTokens(err?.message)}`)
  }

  const today = isoDate(new Date())
  let written = 0
  for (const [date, cols] of byDate) {
    const { error } = await admin.from('social_account_insights_daily').upsert(
      {
        account_id: account.id,
        metric_date: date,
        ...cols,
        ...(date === today && followers !== null ? { followers_count: followers } : {}),
        raw: cols,
      },
      { onConflict: 'account_id,metric_date' },
    )
    if (error) errors.push(`IG daily ${date}: ${error.message}`)
    else written++
  }
  return written
}

const IG_MEDIA_INSIGHT_METRICS = 'views,reach,likes,comments,shares,saved,total_interactions'

async function syncInstagramMedia(
  admin: SupabaseClient,
  account: any,
  token: string,
  errors: string[],
): Promise<number> {
  let media: any[] = []
  try {
    media = await metaGraphAll<any>(`${account.external_id}/media`, {
      token,
      params: {
        fields:
          'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count',
        limit: 50,
      },
      maxPages: 2,
    })
  } catch (err: any) {
    errors.push(`IG media list: ${redactTokens(err?.message)}`)
    return 0
  }

  // Insights only for the most recent 30 items per sync — media-level metrics
  // stabilize after a few days and BUC rate limits are per-account.
  const withInsights = new Set(media.slice(0, 30).map((m) => m.id))

  let written = 0
  for (const item of media) {
    let metrics: Record<string, number> = {}
    if (withInsights.has(item.id)) {
      try {
        const ins = await metaGraph<{ data?: any[] }>(`${item.id}/insights`, {
          token,
          params: { metric: IG_MEDIA_INSIGHT_METRICS },
          retries: 1,
        })
        for (const series of ins.data ?? []) {
          metrics[series.name] = Number(series.values?.[0]?.value ?? series.total_value?.value ?? 0)
        }
      } catch {
        // Story insights expire after 24h; some media types lack some metrics.
        metrics = {}
      }
    }

    const likes = metrics.likes ?? item.like_count ?? null
    const comments = metrics.comments ?? item.comments_count ?? null
    const reach = metrics.reach ?? null
    const totalInteractions =
      metrics.total_interactions ?? ((likes ?? 0) + (comments ?? 0) + (metrics.shares ?? 0) + (metrics.saved ?? 0))

    const { error } = await admin.from('social_media_items').upsert(
      {
        account_id: account.id,
        external_media_id: item.id,
        media_type: item.media_type ?? null,
        media_product_type: item.media_product_type ?? 'FEED',
        caption: item.caption ?? null,
        permalink: item.permalink ?? null,
        thumbnail_url: item.thumbnail_url ?? null,
        media_url: item.media_url ?? null,
        posted_at: item.timestamp ?? null,
        is_story: item.media_product_type === 'STORY',
        story_expires_at:
          item.media_product_type === 'STORY' && item.timestamp
            ? new Date(new Date(item.timestamp).getTime() + 24 * 60 * 60 * 1000).toISOString()
            : null,
        views: metrics.views ?? null,
        reach,
        likes,
        comments,
        shares: metrics.shares ?? null,
        saves: metrics.saved ?? null,
        total_interactions: totalInteractions,
        engagement_rate:
          reach && reach > 0 ? Number(((totalInteractions / reach) * 100).toFixed(4)) : null,
        raw_insights: metrics,
        last_insights_at: withInsights.has(item.id) ? new Date().toISOString() : undefined,
      },
      { onConflict: 'account_id,external_media_id' },
    )
    if (error) errors.push(`IG media ${item.id}: ${error.message}`)
    else written++
  }

  // Active stories (separate edge; insights die within 24h so grab them now)
  try {
    const stories = await metaGraphAll<any>(`${account.external_id}/stories`, {
      token,
      params: { fields: 'id,media_type,media_url,thumbnail_url,permalink,timestamp,caption' },
      maxPages: 1,
    })
    for (const story of stories) {
      let metrics: Record<string, number> = {}
      try {
        const ins = await metaGraph<{ data?: any[] }>(`${story.id}/insights`, {
          token,
          params: { metric: 'views,reach,replies,navigation,total_interactions' },
          retries: 1,
        })
        for (const series of ins.data ?? []) {
          metrics[series.name] = Number(series.values?.[0]?.value ?? series.total_value?.value ?? 0)
        }
      } catch {
        metrics = {}
      }
      await admin.from('social_media_items').upsert(
        {
          account_id: account.id,
          external_media_id: story.id,
          media_type: story.media_type ?? null,
          media_product_type: 'STORY',
          caption: story.caption ?? null,
          permalink: story.permalink ?? null,
          thumbnail_url: story.thumbnail_url ?? null,
          media_url: story.media_url ?? null,
          posted_at: story.timestamp ?? null,
          is_story: true,
          story_expires_at: story.timestamp
            ? new Date(new Date(story.timestamp).getTime() + 24 * 60 * 60 * 1000).toISOString()
            : null,
          views: metrics.views ?? null,
          reach: metrics.reach ?? null,
          total_interactions: metrics.total_interactions ?? null,
          raw_insights: metrics,
          last_insights_at: new Date().toISOString(),
        },
        { onConflict: 'account_id,external_media_id' },
      )
    }
  } catch {
    /* stories edge may be unavailable — non-fatal */
  }

  return written
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Full insight sync for one social account (daily series + media registry).
 * Never throws; the result carries partial errors. Stamps
 * last_synced_at/last_error on the account row.
 */
export async function syncSocialAccount(
  admin: SupabaseClient,
  accountRowId: string,
  days = 30,
): Promise<SyncAccountResult> {
  const errors: string[] = []
  const { data: account } = await admin
    .from('social_accounts')
    .select('*')
    .eq('id', accountRowId)
    .maybeSingle()
  if (!account) return { ok: false, dailyRows: 0, mediaItems: 0, errors: ['Account not found'] }
  if (account.status === 'disconnected') {
    return { ok: false, dailyRows: 0, mediaItems: 0, errors: ['Account disconnected'] }
  }

  const token = await resolveAccountToken(admin, account)
  if (!token) {
    await admin
      .from('social_accounts')
      .update({ status: 'needs_reauth', last_error: 'No usable token' })
      .eq('id', account.id)
    return { ok: false, dailyRows: 0, mediaItems: 0, errors: ['No usable token'] }
  }

  let dailyRows = 0
  let mediaItems = 0
  try {
    if (account.platform === 'facebook_page') {
      dailyRows = await syncFacebookPageInsights(admin, account, token, days, errors)
      mediaItems = await syncFacebookPagePosts(admin, account, token, errors)
    } else {
      dailyRows = await syncInstagramAccountInsights(admin, account, token, days, errors)
      mediaItems = await syncInstagramMedia(admin, account, token, errors)
    }
  } catch (err: any) {
    const flagged = await flagAuthError(admin, account.id, err)
    errors.push(redactTokens(err?.message ?? 'Sync failed'))
    if (flagged) return { ok: false, dailyRows, mediaItems, errors }
  }

  await admin
    .from('social_accounts')
    .update({
      last_synced_at: new Date().toISOString(),
      last_error: errors.length ? errors.slice(0, 3).join(' | ').slice(0, 500) : null,
      ...(account.status === 'error' && !errors.length ? { status: 'connected' } : {}),
    })
    .eq('id', account.id)

  return { ok: errors.length === 0, dailyRows, mediaItems, errors }
}
