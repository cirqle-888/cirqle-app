/**
 * Comments on Instagram and Facebook — reading and answering them.
 *
 * Verified against the live API before this was written: Instagram returns
 * { id, text, username, timestamp, like_count } and Facebook returns
 * { id, message, from, created_time, like_count }, which is why inbox.ts
 * normalises rather than assuming they agree.
 *
 * Comments are fetched WITH their media in one call. The alternative — list
 * posts, then a request per post — is a dozen round trips for one screen, and
 * the daily sync already showed how a per-account request budget disappears.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { metaGraph, redactTokens } from './client'
import { decryptToken } from '@/lib/integrations/tokens'
import {
  normaliseIgComment, normaliseFbComment, sortThreads,
  type InboxComment, type RawIgComment, type RawFbComment,
} from '@/lib/social-hub/inbox'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

/** Same resolution order the publisher uses: page token, linked page, connection. */
async function tokenFor(admin: SupabaseClient, account: Row): Promise<string | null> {
  let token = decryptToken(account.access_token)
  if (!token && account.linked_page_account_id) {
    const { data: page } = await admin
      .from('social_accounts').select('access_token').eq('id', account.linked_page_account_id).maybeSingle()
    token = decryptToken((page as Row | null)?.access_token)
  }
  if (!token && account.connection_id) {
    const { data: conn } = await admin
      .from('provider_connections').select('access_token, status').eq('id', account.connection_id).maybeSingle()
    const c = conn as Row | null
    if (c?.status === 'active') token = decryptToken(c.access_token)
  }
  return token
}

export interface InboxPost {
  mediaId: string
  caption: string
  permalink: string | null
  thumbnailUrl: string | null
  postedAt: string | null
  threads: InboxComment[]
}

/**
 * Recent posts for one account, each with its comment threads.
 *
 * @param postLimit how many recent posts to look at. Comments live on posts,
 *   so this is the real cost knob — every post is a comments edge in the same
 *   response.
 */
export async function loadAccountInbox(
  admin: SupabaseClient,
  accountId: string,
  postLimit = 15,
): Promise<{ ok: boolean; posts: InboxPost[]; error?: string }> {
  const { data } = await admin
    .from('social_accounts')
    .select('id, platform, external_id, username, name, access_token, connection_id, linked_page_account_id, status')
    .eq('id', accountId)
    .maybeSingle()
  const account = data as Row | null
  if (!account) return { ok: false, posts: [], error: 'Account not found.' }
  if (account.status === 'disconnected') return { ok: false, posts: [], error: 'Account disconnected.' }

  const token = await tokenFor(admin, account)
  if (!token) return { ok: false, posts: [], error: 'No usable access token — reconnect the Meta account.' }

  try {
    return account.platform === 'instagram'
      ? { ok: true, posts: await loadInstagram(account, token, postLimit) }
      : { ok: true, posts: await loadFacebook(account, token, postLimit) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, posts: [], error: redactTokens(msg) }
  }
}

async function loadInstagram(account: Row, token: string, limit: number): Promise<InboxPost[]> {
  const res = await metaGraph<{ data?: Row[] }>(`${account.external_id}/media`, {
    token,
    params: {
      fields:
        'id,caption,permalink,thumbnail_url,media_url,timestamp,comments_count,' +
        'comments{id,text,username,timestamp,like_count,replies{id,text,username,timestamp,like_count}}',
      limit,
    },
    retries: 1,
  })
  const own = String(account.username ?? '')
  return (res.data ?? [])
    .map((m): InboxPost => ({
      mediaId: m.id,
      caption: String(m.caption ?? ''),
      permalink: m.permalink ?? null,
      thumbnailUrl: m.thumbnail_url ?? m.media_url ?? null,
      postedAt: m.timestamp ?? null,
      threads: sortThreads(((m.comments?.data ?? []) as RawIgComment[])
        .map(c => normaliseIgComment(c, account.id, m.id, own))),
    }))
    .filter(p => p.threads.length > 0)
}

async function loadFacebook(account: Row, token: string, limit: number): Promise<InboxPost[]> {
  const res = await metaGraph<{ data?: Row[] }>(`${account.external_id}/published_posts`, {
    token,
    params: {
      fields:
        'id,message,permalink_url,full_picture,created_time,' +
        'comments{id,message,from,created_time,like_count,comments{id,message,from,created_time,like_count}}',
      limit,
    },
    retries: 1,
  })
  const own = String(account.external_id ?? '')
  return (res.data ?? [])
    .map((p): InboxPost => ({
      mediaId: p.id,
      caption: String(p.message ?? ''),
      permalink: p.permalink_url ?? null,
      thumbnailUrl: p.full_picture ?? null,
      postedAt: p.created_time ?? null,
      threads: sortThreads(((p.comments?.data ?? []) as RawFbComment[])
        .map(c => normaliseFbComment(c, account.id, p.id, own))),
    }))
    .filter(p => p.threads.length > 0)
}

/* ── Writing back ───────────────────────────────────────────────────────── */

async function tokenForAccount(admin: SupabaseClient, accountId: string) {
  const { data } = await admin
    .from('social_accounts')
    .select('id, platform, external_id, access_token, connection_id, linked_page_account_id')
    .eq('id', accountId).maybeSingle()
  const account = data as Row | null
  if (!account) return { account: null, token: null }
  return { account, token: await tokenFor(admin, account) }
}

/**
 * Reply to a comment.
 *
 * The endpoints differ in shape as well as name: Instagram posts to a
 * /replies edge with `message`, Facebook posts to the comment's own /comments
 * edge. Both return the new comment's id.
 */
export async function replyToComment(
  admin: SupabaseClient,
  accountId: string,
  commentId: string,
  message: string,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const body = message.trim()
  if (!body) return { ok: false, error: 'Write something first.' }

  const { account, token } = await tokenForAccount(admin, accountId)
  if (!account) return { ok: false, error: 'Account not found.' }
  if (!token) return { ok: false, error: 'No usable access token — reconnect the Meta account.' }

  try {
    const path = account.platform === 'instagram' ? `${commentId}/replies` : `${commentId}/comments`
    const res = await metaGraph<{ id: string }>(path, {
      method: 'POST', token, body: { message: body }, retries: 1,
    })
    return { ok: true, id: res.id }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: redactTokens(msg) }
  }
}

/**
 * Hide or unhide a comment.
 *
 * Hiding leaves it visible to its author and their friends, which is why it is
 * the usual answer to spam — deleting is visible as an absence and invites a
 * second, angrier comment.
 */
export async function setCommentHidden(
  admin: SupabaseClient,
  accountId: string,
  commentId: string,
  hidden: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const { account, token } = await tokenForAccount(admin, accountId)
  if (!account) return { ok: false, error: 'Account not found.' }
  if (!token) return { ok: false, error: 'No usable access token — reconnect the Meta account.' }

  try {
    await metaGraph(`${commentId}`, {
      method: 'POST', token,
      // Instagram spells it `hide`; Facebook spells it `is_hidden`.
      body: account.platform === 'instagram' ? { hide: hidden } : { is_hidden: hidden },
      retries: 1,
    })
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: redactTokens(msg) }
  }
}

/** Delete a comment. Irreversible on both platforms. */
export async function deleteComment(
  admin: SupabaseClient,
  accountId: string,
  commentId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { account, token } = await tokenForAccount(admin, accountId)
  if (!account) return { ok: false, error: 'Account not found.' }
  if (!token) return { ok: false, error: 'No usable access token — reconnect the Meta account.' }

  try {
    await metaGraph(`${commentId}`, { method: 'DELETE', token, retries: 1 })
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: redactTokens(msg) }
  }
}
