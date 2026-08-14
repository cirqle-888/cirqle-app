'use server'

/**
 * Client feed approval — the only writes an unauthenticated visitor can make.
 *
 * SECURITY: every action re-validates the share token server-side and scopes
 * the write to that token's account. The postId is treated as untrusted input:
 * a valid token for account A can never approve a creative on account B, and a
 * token that is revoked or expired can do nothing at all.
 *
 * There is deliberately no permission check here — the token IS the credential.
 * That is why it grants exactly two verbs (approve, request changes) on exactly
 * the posts already sent for review, and nothing else.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { logActivity } from '@/lib/activity/log'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

/** Statuses a client is allowed to act on — anything else is not theirs to judge. */
const REVIEWABLE = ['awaiting_approval', 'changes_requested', 'approved']

/**
 * Resolve a share token to its account, or explain why it cannot be used.
 * Every action funnels through this, so the expiry/revocation rules live once.
 */
async function resolveToken(token: string) {
  const admin = createAdminClient()
  const { data: link } = await admin
    .from('feed_share_links')
    .select('id, account_id, client_id, expires_at, revoked_at')
    .eq('token', token)
    .maybeSingle()

  if (!link) return { error: 'This link is no longer valid.' as const }
  if (link.revoked_at) return { error: 'This link has been withdrawn.' as const }
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    return { error: 'This link has expired.' as const }
  }
  return { admin, link }
}

/** The client approves one creative. */
export async function clientApproveCreative(
  token: string,
  postId: string,
): Promise<ActionResult> {
  const resolved = await resolveToken(token)
  if ('error' in resolved) return { ok: false, error: resolved.error }
  const { admin, link } = resolved

  const { data: post } = await admin
    .from('social_posts')
    .select('id, account_id, client_id, status, scheduled_at')
    .eq('id', postId)
    .maybeSingle()

  // Scoped to the token's own account — a valid token for one feed must never
  // reach another.
  if (!post || post.account_id !== link.account_id) {
    return { ok: false, error: 'That post is not part of this plan.' }
  }
  if (!REVIEWABLE.includes(post.status)) {
    return { ok: false, error: 'This post is no longer awaiting your approval.' }
  }

  // Approving something already dated schedules it, matching the internal
  // approve action — one behaviour, not two.
  const next = post.scheduled_at ? 'scheduled' : 'approved'
  const { error } = await admin
    .from('social_posts')
    .update({ status: next, review_note: null, reviewed_at: new Date().toISOString() })
    .eq('id', postId)
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId: null,
    entityType: 'client', entityId: post.client_id, clientId: post.client_id,
    category: 'crm', action: 'social_post_client_approved',
    detail: { post_id: postId, via: 'share_link' },
  }).catch(() => {})

  revalidatePath(`/feed/${token}`)
  revalidatePath('/dashboard/social/feed')
  return { ok: true }
}

/** The client asks for changes, with a note explaining what. */
export async function clientRequestChanges(
  token: string,
  postId: string,
  note: string,
): Promise<ActionResult> {
  const trimmed = (note ?? '').trim()
  // A bare "needs changes" with no reason sends the designer back to guess.
  if (trimmed.length < 3) {
    return { ok: false, error: 'Please say briefly what you would like changed.' }
  }

  const resolved = await resolveToken(token)
  if ('error' in resolved) return { ok: false, error: resolved.error }
  const { admin, link } = resolved

  const { data: post } = await admin
    .from('social_posts')
    .select('id, account_id, client_id, status')
    .eq('id', postId)
    .maybeSingle()

  if (!post || post.account_id !== link.account_id) {
    return { ok: false, error: 'That post is not part of this plan.' }
  }
  if (!REVIEWABLE.includes(post.status)) {
    return { ok: false, error: 'This post is no longer open for review.' }
  }

  const { error } = await admin
    .from('social_posts')
    .update({
      status: 'changes_requested',
      // Capped: this lands in a UI, not a document.
      review_note: trimmed.slice(0, 1000),
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', postId)
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId: null,
    entityType: 'client', entityId: post.client_id, clientId: post.client_id,
    category: 'crm', action: 'social_post_changes_requested',
    detail: { post_id: postId, note: trimmed.slice(0, 200), via: 'share_link' },
  }).catch(() => {})

  revalidatePath(`/feed/${token}`)
  revalidatePath('/dashboard/social/feed')
  return { ok: true }
}
