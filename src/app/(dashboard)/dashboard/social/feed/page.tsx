import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { buildFeedGrid } from '@/lib/social/feed-grid'
import { parseFeedAspect, FEED_ASPECT_KEY } from '@/lib/social/feed-aspect'
import FeedPlannerClient from './feed-planner-client'

export const dynamic = 'force-dynamic'

/**
 * Instagram Feed Planner — arrange creatives the way the client will see them.
 *
 * Reads the two sources the grid is made of (planned social_posts, published
 * social_media_items) and hands them to the shared, tested builder so the
 * planner, the client link and any export order tiles identically.
 */
export default async function FeedPlannerPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canPlan = isAdmin || hasPermission(me, PERMS.SOCIAL_PLAN_FEED)
  if (!(canPlan || hasPermission(me, PERMS.SOCIAL_VIEW_INSIGHTS))) redirect('/dashboard')

  const admin = createAdminClient()
  const sp = searchParams ? await searchParams : undefined
  const requested = typeof sp?.account === 'string' ? sp.account : null

  // Instagram accounts only — a feed grid is an Instagram concept. Client-owned
  // and Cirqle-owned both appear; the planner is useful for our own feed too.
  let accounts: { id: string; name: string; username: string | null; client_id: string | null; profile_picture_url: string | null; followers_count: number | null }[] = []
  try {
    const { data } = await admin
      .from('social_accounts')
      .select('id, name, username, client_id, profile_picture_url, followers_count')
      .eq('platform', 'instagram')
      .neq('status', 'disconnected')
      .order('name')
    accounts = (data ?? []) as typeof accounts
  } catch { /* pre-migration */ }

  const selected = accounts.find(a => a.id === requested) ?? accounts[0] ?? null

  let planned: Record<string, unknown>[] = []
  let published: Record<string, unknown>[] = []
  let shareLinks: Record<string, unknown>[] = []

  if (selected) {
    // grid_order arrives with 20260814160000; without it the planner still
    // renders (every tile simply reads as an unplaced draft) rather than 500ing.
    const plannedRes = await admin
      .from('social_posts')
      .select('id, status, media, caption, hashtags, scheduled_at, grid_order, review_note')
      .eq('account_id', selected.id)
      .then(r => r.error
        ? admin.from('social_posts')
            .select('id, status, media, caption, hashtags, scheduled_at')
            .eq('account_id', selected.id)
        : r)
    planned = (plannedRes.data ?? []) as Record<string, unknown>[]

    const { data: media } = await admin
      .from('social_media_items')
      .select('id, thumbnail_url, media_url, permalink, caption, posted_at, media_type, media_product_type, likes, comments')
      .eq('account_id', selected.id)
      .order('posted_at', { ascending: false })
      .limit(60)
    published = (media ?? []) as Record<string, unknown>[]

    try {
      const { data: links } = await admin
        .from('feed_share_links')
        .select('id, token, label, expires_at, revoked_at, created_at, last_used_at')
        .eq('account_id', selected.id)
        .is('revoked_at', null)
        .order('created_at', { ascending: false })
      shareLinks = (links ?? []) as Record<string, unknown>[]
    } catch { /* table arrives with the same migration */ }
  }

  // Instagram has changed its grid crop before and will again — so the ratio
  // is a setting, not a constant. One dropdown, no deploy.
  let aspectRaw: string | null = null
  try {
    const { data } = await admin
      .from('company_settings').select('value').eq('key', FEED_ASPECT_KEY).maybeSingle()
    aspectRaw = data?.value ?? null
  } catch { /* unset — the parser falls back to the default */ }

  const grid = buildFeedGrid({
    planned: planned as never,
    published: published as never,
  })

  return (
    <FeedPlannerClient
      accounts={accounts}
      selectedId={selected?.id ?? null}
      profile={selected}
      tiles={grid.tiles}
      plannedCount={grid.plannedCount}
      publishedCount={grid.publishedCount}
      shareLinks={shareLinks as never}
      canPlan={canPlan}
      aspect={parseFeedAspect(aspectRaw)}
    />
  )
}
