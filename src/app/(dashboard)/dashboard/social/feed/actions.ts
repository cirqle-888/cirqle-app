'use server'

/**
 * Feed Planner — server actions.
 *
 * Reuses the existing publishing pipeline wholesale: creatives are ordinary
 * `social_posts` rows, uploads go through the same `social-media` bucket, and
 * approval/scheduling stay in the calendar's actions. What lives here is only
 * what the grid adds — placing a tile, reordering, and sharing the plan.
 *
 * A `'use server'` module may only EXPORT async functions; types stay local.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { reorderGrid, isReadyForApproval } from '@/lib/social/feed-grid'
import { parseFeedAspect, FEED_ASPECT_KEY } from '@/lib/social/feed-aspect'

const REVALIDATE = '/dashboard/social/feed'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

/** Columns safe to read for logging/scoping — never a token. */
const POST_META = 'id, client_id, account_id, status, grid_order, media, caption'

// ── Placing a creative ───────────────────────────────────────────────────────

/**
 * Create a planned tile from an uploaded image.
 *
 * The creative goes straight into the grid at the top (grid_order 0), because
 * that is where a newly made piece belongs on Instagram — everything already
 * planned shifts down by one.
 */
export async function addFeedCreative(input: {
  accountId: string
  /** NULL for one of Cirqle's own accounts, which have no client by design. */
  clientId: string | null
  mediaUrl: string
  storagePath?: string | null
  contentType?: 'image' | 'video'
}): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.SOCIAL_PLAN_FEED)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!input.accountId) return { ok: false, error: 'Pick an Instagram account first.' }
  if (!input.mediaUrl) return { ok: false, error: 'The upload did not complete — try again.' }

  const admin = createAdminClient()

  // Everything already placed moves down one. Done before the insert so a
  // failure here cannot leave two tiles claiming position 0.
  const { data: placed } = await admin
    .from('social_posts')
    .select('id, grid_order')
    .eq('account_id', input.accountId)
    .not('grid_order', 'is', null)
    .order('grid_order')

  for (const row of (placed ?? []) as { id: string; grid_order: number }[]) {
    await admin.from('social_posts')
      .update({ grid_order: row.grid_order + 1 }).eq('id', row.id)
  }

  const { data, error } = await admin
    .from('social_posts')
    .insert({
      client_id: input.clientId,
      account_id: input.accountId,
      content_type: input.contentType === 'video' ? 'video' : 'image',
      status: 'draft',
      grid_order: 0,
      media: [{
        url: input.mediaUrl,
        type: input.contentType === 'video' ? 'video' : 'image',
        storage_path: input.storagePath ?? null,
      }],
      created_by: guard.employeeId ?? null,
    })
    .select('id')
    .single()

  if (error) {
    // grid_order arrives with migration 20260814160000; say which one.
    if (/grid_order|column .* does not exist/i.test(error.message)) {
      return { ok: false, error: 'The Feed Planner migration (20260814160000) has not been run yet.' }
    }
    return { ok: false, error: error.message }
  }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { id: data.id } }
}

// ── Rearranging ──────────────────────────────────────────────────────────────

/**
 * Move one tile to a new position.
 *
 * The new positions are computed by a pure, tested function
 * (@/lib/social/feed-grid) and only the rows that actually changed are written
 * — a reorder near the top of a long feed touches three rows, not thirty.
 */
export async function moveFeedTile(input: {
  accountId: string
  plannedIds: string[]
  movedId: string
  toIndex: number
}): Promise<ActionResult<{ moved: number }>> {
  const guard = await requirePermission(PERMS.SOCIAL_PLAN_FEED)
  if (!guard.ok) return { ok: false, error: guard.error }

  const changed = reorderGrid(input.plannedIds, input.movedId, input.toIndex)
  if (changed.length === 0) return { ok: true, data: { moved: 0 } }

  const admin = createAdminClient()
  for (const c of changed) {
    const { error } = await admin
      .from('social_posts')
      .update({ grid_order: c.grid_order })
      .eq('id', c.id)
      // Scoped to the account so a stale client list can never renumber
      // another account's feed.
      .eq('account_id', input.accountId)
    if (error) return { ok: false, error: error.message }
  }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { moved: changed.length } }
}

/** Take a creative out of the grid without deleting it. */
export async function unplaceFeedTile(postId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_PLAN_FEED)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('social_posts').update({ grid_order: null }).eq('id', postId)
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * Delete a planned creative outright.
 *
 * Refuses anything already live or mid-publish: the grid is a plan, and
 * deleting a row here must never look like it un-publishes a real Instagram
 * post. Removing it from Instagram is a separate, deliberate act.
 */
export async function deleteFeedCreative(postId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_PLAN_FEED)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: post } = await admin
    .from('social_posts').select(POST_META).eq('id', postId).maybeSingle()
  if (!post) return { ok: false, error: 'Creative not found.' }
  if (['published', 'publishing'].includes(post.status)) {
    return { ok: false, error: 'This post is already live on Instagram. Remove it there first.' }
  }

  const { error } = await admin.from('social_posts').delete().eq('id', postId)
  if (error) return { ok: false, error: error.message }

  // Logged against the CLIENT when there is one, and against the account
  // otherwise — content on one of Cirqle's own feeds has no client, and a
  // client-typed entry carrying a null client id is a row nothing can join to.
  void logActivity(post.client_id
    ? {
        actorId: guard.employeeId,
        entityType: 'client', entityId: post.client_id, clientId: post.client_id,
        category: 'crm', action: 'social_creative_deleted',
        detail: { caption: (post.caption ?? '').slice(0, 80) },
      }
    : {
        actorId: guard.employeeId,
        entityType: 'social_account', entityId: post.account_id,
        category: 'crm', action: 'social_creative_deleted',
        detail: { caption: (post.caption ?? '').slice(0, 80), owner: 'cirqle' },
      },
  ).catch(() => {})

  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ── Client approval ──────────────────────────────────────────────────────────

/**
 * Send every placed, image-bearing creative to the client for approval.
 *
 * Empty placeholders are skipped rather than sent — a blank tile wastes the
 * client's attention and makes the agency look careless. The count of what was
 * skipped is returned so the caller can say so.
 */
export async function sendFeedForApproval(accountId: string): Promise<ActionResult<{ sent: number; skipped: number }>> {
  const guard = await requirePermission(PERMS.SOCIAL_PLAN_FEED)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: posts } = await admin
    .from('social_posts')
    .select('id, status, media')
    .eq('account_id', accountId)
    .not('grid_order', 'is', null)
    .in('status', ['draft', 'changes_requested'])

  let sent = 0, skipped = 0
  for (const p of (posts ?? []) as { id: string; status: string; media: unknown }[]) {
    if (!isReadyForApproval(p)) { skipped++; continue }
    const { error } = await admin
      .from('social_posts')
      .update({ status: 'awaiting_approval' })
      .eq('id', p.id)
    if (!error) sent++
  }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { sent, skipped } }
}

/** Record the client's verdict on one creative. */
export async function reviewFeedCreative(input: {
  postId: string
  decision: 'approved' | 'changes_requested'
  note?: string | null
}): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_APPROVE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: post } = await admin
    .from('social_posts')
    .select('id, client_id, account_id, status, grid_order, media, caption, scheduled_at')
    .eq('id', input.postId).maybeSingle()
  if (!post) return { ok: false, error: 'Creative not found.' }

  // Approving something that already has a date schedules it, matching what
  // the calendar's own approve action does — one behaviour, not two.
  const nextStatus = input.decision === 'approved'
    ? (post.scheduled_at ? 'scheduled' : 'approved')
    : 'changes_requested'

  const { error } = await admin
    .from('social_posts')
    .update({
      status: nextStatus,
      review_note: input.decision === 'changes_requested' ? (input.note?.trim() || null) : null,
      reviewed_at: new Date().toISOString(),
      ...(input.decision === 'approved'
        ? { approved_by: guard.employeeId ?? null, approved_at: new Date().toISOString() }
        : {}),
    })
    .eq('id', input.postId)
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** Create a read-only link to this account's planned grid. */
export async function createFeedShareLink(input: {
  accountId: string
  clientId: string | null
  label?: string | null
  expiresInDays?: number | null
}): Promise<ActionResult<{ token: string }>> {
  const guard = await requirePermission(PERMS.SOCIAL_PLAN_FEED)
  if (!guard.ok) return { ok: false, error: guard.error }

  // 32 hex chars from crypto — guessing one is not a realistic attack.
  const token = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0')).join('')

  const admin = createAdminClient()
  const { error } = await admin.from('feed_share_links').insert({
    account_id: input.accountId,
    client_id: input.clientId,
    token,
    label: input.label?.trim() || null,
    expires_at: input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString()
      : null,
    created_by: guard.employeeId ?? null,
  })
  if (error) {
    if (/feed_share_links/.test(error.message)) {
      return { ok: false, error: 'The Feed Planner migration (20260814160000) has not been run yet.' }
    }
    return { ok: false, error: error.message }
  }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { token } }
}

/** Withdraw a share link without deleting the record of it. */
export async function revokeFeedShareLink(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_PLAN_FEED)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('feed_share_links').update({ revoked_at: new Date().toISOString() }).eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ── Grid crop ────────────────────────────────────────────────────────────────

/**
 * Set the aspect ratio the feed grid renders at.
 *
 * Instagram has changed its profile crop before and will again. Storing it in
 * company_settings means the next change is a dropdown, not a code change and a
 * deploy — and both the planner and the client's approval view read the same
 * key, so the two can never show different shapes.
 */
export async function setFeedAspect(aspect: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_PLAN_FEED)
  if (!guard.ok) return { ok: false, error: guard.error }

  // Validate against the known set — never write an arbitrary string into a
  // key that drives layout.
  const parsed = parseFeedAspect(aspect)
  if (parsed !== aspect) return { ok: false, error: 'Unsupported ratio.' }

  const admin = createAdminClient()
  const { error } = await admin
    .from('company_settings')
    .upsert({ key: FEED_ASPECT_KEY, value: parsed }, { onConflict: 'key' })
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE)
  return { ok: true }
}
