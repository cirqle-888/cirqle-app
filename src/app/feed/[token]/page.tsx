import { createAdminClient } from '@/lib/supabase/admin'
import { buildFeedGrid } from '@/lib/social/feed-grid'
import { parseFeedAspect, FEED_ASPECT_KEY } from '@/lib/social/feed-aspect'
import ClientFeedView from './client-feed-view'

export const dynamic = 'force-dynamic'

/**
 * Client-facing feed approval — a read-only grid behind a share token.
 *
 * PUBLIC ROUTE: the token is the only credential, so this page is deliberately
 * narrow. It reveals one account's planned grid and nothing else — no client
 * list, no other accounts, no money, no internal notes beyond the caption the
 * client is being asked to approve.
 *
 * A revoked or expired link says so plainly rather than 404ing, because "this
 * link was withdrawn" is a different message from "you typed it wrong", and the
 * client deserves to know which.
 */
export default async function ClientFeedPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  let admin: ReturnType<typeof createAdminClient>
  try {
    admin = createAdminClient()
  } catch {
    return <Notice title="Not available" body="This preview link cannot be opened right now." />
  }

  const { data: link } = await admin
    .from('feed_share_links')
    .select('id, account_id, client_id, label, expires_at, revoked_at')
    .eq('token', token)
    .maybeSingle()

  if (!link) {
    return <Notice title="Link not found" body="Check the address, or ask your agency contact for a fresh link." />
  }
  if (link.revoked_at) {
    return <Notice title="This link was withdrawn" body="Your agency contact can send you a new one." />
  }
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    return <Notice title="This link has expired" body="Ask your agency contact for a fresh link — the plan may have moved on since." />
  }

  // Record the visit; never let a logging failure block the view.
  void admin.from('feed_share_links')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', link.id)
    .then(() => {}, () => {})

  const { data: account } = await admin
    .from('social_accounts')
    .select('id, name, username, profile_picture_url, followers_count')
    .eq('id', link.account_id)
    .maybeSingle()

  if (!account) {
    return <Notice title="Nothing to show" body="This account is no longer available." />
  }

  // Only what the client is being asked to look at: placed creatives, and the
  // real posts they will sit above. Never drafts still being worked on.
  const { data: planned } = await admin
    .from('social_posts')
    .select('id, status, media, caption, hashtags, scheduled_at, grid_order, review_note')
    .eq('account_id', account.id)
    .not('grid_order', 'is', null)
    .in('status', ['awaiting_approval', 'changes_requested', 'approved', 'scheduled'])

  const { data: published } = await admin
    .from('social_media_items')
    .select('id, thumbnail_url, media_url, permalink, caption, posted_at, media_type, media_product_type')
    .eq('account_id', account.id)
    .order('posted_at', { ascending: false })
    .limit(30)

  const grid = buildFeedGrid({
    planned: (planned ?? []) as never,
    published: (published ?? []) as never,
  })

  // The SAME setting the planner uses — the client must see the crop the
  // agency approved, not a different one.
  let aspectRaw: string | null = null
  try {
    const { data } = await admin
      .from('company_settings').select('value').eq('key', FEED_ASPECT_KEY).maybeSingle()
    aspectRaw = data?.value ?? null
  } catch { /* unset */ }

  // The agency's own name, for a header the client recognises.
  let agencyName = 'Your agency'
  try {
    const { data } = await admin
      .from('company_settings').select('value').eq('key', 'company_name').maybeSingle()
    if (data?.value) agencyName = data.value
  } catch { /* default */ }

  return (
    <ClientFeedView
      token={token}
      agencyName={agencyName}
      label={link.label}
      account={account as never}
      tiles={grid.tiles}
      plannedCount={grid.plannedCount}
      publishedCount={grid.publishedCount}
      aspect={parseFeedAspect(aspectRaw)}
    />
  )
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="text-center max-w-sm">
        <h1 className="text-lg font-semibold mb-2">{title}</h1>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}
