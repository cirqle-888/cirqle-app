/**
 * Meta content publisher — Facebook Pages + Instagram (feed, carousel, Reels,
 * Stories). Called by the social-publisher cron for due scheduled posts and by
 * the "Publish now" server action.
 *
 * Instagram flow (Content Publishing API):
 *   POST /{ig-user-id}/media (container) → poll status_code → media_publish.
 *   Carousels: child containers → CAROUSEL parent → publish.
 *   Reels: media_type=REELS (all IG video posts are Reels).
 *   Stories: media_type=STORIES (image or ≤60 s video), publish-now only.
 *   First comment: POST /{media-id}/comments after publish.
 *   NO native scheduling — Cirqle's queue is the scheduler.
 *
 * Facebook flow: /{page}/feed (text/link), /{page}/photos (single & multi via
 * attached_media), /{page}/videos (hosted file_url); Reels via /{page}/videos
 * with the caption noting the 9:16 constraint enforced in validation.
 *
 * All media URLs must be PUBLICLY downloadable by Meta — Cirqle stores post
 * media in the public 'social-media' Supabase bucket with UUID paths.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { metaGraph, MetaApiError, redactTokens } from './client'
import { decryptToken } from '@/lib/integrations/tokens'
import { createNotification, notifyAdmins } from '@/lib/notifications/create'
import type { MediaDescriptor } from '@/lib/social-hub/validation'

export interface PublishResult {
  ok: boolean
  externalMediaId?: string
  permalink?: string
  error?: string
  /** true when the failure is a token/permission problem → needs reauth */
  authError?: boolean
}

const CONTAINER_POLL_INTERVAL_MS = 5_000
const CONTAINER_POLL_MAX_MS = 4 * 60 * 1000 // stay under serverless limits

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function fullCaption(post: { caption?: string | null; hashtags?: string | null }): string {
  return [post.caption ?? '', post.hashtags ?? ''].map((s) => s.trim()).filter(Boolean).join('\n\n')
}

// ── Instagram ────────────────────────────────────────────────────────────────

async function waitForContainer(containerId: string, token: string): Promise<void> {
  const start = Date.now()
  for (;;) {
    const status = await metaGraph<{ status_code?: string; status?: string }>(`${containerId}`, {
      token,
      params: { fields: 'status_code,status' },
      retries: 1,
    })
    if (status.status_code === 'FINISHED') return
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
      throw new Error(`Media container ${status.status_code}: ${status.status ?? 'processing failed'}`)
    }
    if (Date.now() - start > CONTAINER_POLL_MAX_MS) {
      throw new Error('Media container processing timed out — will retry on the next publisher run')
    }
    await sleep(CONTAINER_POLL_INTERVAL_MS)
  }
}

async function publishInstagram(
  igUserId: string,
  token: string,
  post: any,
  media: MediaDescriptor[],
): Promise<PublishResult> {
  const caption = fullCaption(post)
  let creationId: string

  if (post.content_type === 'carousel') {
    const childIds: string[] = []
    for (const item of media) {
      const child = await metaGraph<{ id: string }>(`${igUserId}/media`, {
        method: 'POST',
        token,
        body:
          item.type === 'video'
            ? { media_type: 'REELS', video_url: item.url, is_carousel_item: true }
            : { image_url: item.url, is_carousel_item: true },
      })
      childIds.push(child.id)
    }
    for (const id of childIds) await waitForContainer(id, token)
    const parent = await metaGraph<{ id: string }>(`${igUserId}/media`, {
      method: 'POST',
      token,
      body: { media_type: 'CAROUSEL', children: childIds.join(','), caption },
    })
    creationId = parent.id
  } else if (post.content_type === 'video' || post.content_type === 'reel') {
    const container = await metaGraph<{ id: string }>(`${igUserId}/media`, {
      method: 'POST',
      token,
      body: {
        media_type: 'REELS',
        video_url: media[0].url,
        caption,
        share_to_feed: post.share_to_feed !== false,
        ...(post.cover_url ? { cover_url: post.cover_url } : {}),
      },
    })
    creationId = container.id
  } else if (post.content_type === 'story_image' || post.content_type === 'story_video') {
    const container = await metaGraph<{ id: string }>(`${igUserId}/media`, {
      method: 'POST',
      token,
      body: {
        media_type: 'STORIES',
        ...(media[0].type === 'video' ? { video_url: media[0].url } : { image_url: media[0].url }),
      },
    })
    creationId = container.id
  } else {
    // single image
    const container = await metaGraph<{ id: string }>(`${igUserId}/media`, {
      method: 'POST',
      token,
      body: { image_url: media[0].url, caption },
    })
    creationId = container.id
  }

  await waitForContainer(creationId, token)

  const published = await metaGraph<{ id: string }>(`${igUserId}/media_publish`, {
    method: 'POST',
    token,
    body: { creation_id: creationId },
  })

  // Permalink + first comment (best-effort)
  let permalink: string | undefined
  try {
    const mediaInfo = await metaGraph<{ permalink?: string }>(`${published.id}`, {
      token,
      params: { fields: 'permalink' },
      retries: 1,
    })
    permalink = mediaInfo.permalink
  } catch { /* non-fatal */ }

  if (post.first_comment?.trim() && !post.content_type.startsWith('story')) {
    try {
      await metaGraph(`${published.id}/comments`, {
        method: 'POST',
        token,
        body: { message: post.first_comment.trim() },
      })
    } catch (err: any) {
      console.warn('[publishInstagram] first comment failed:', redactTokens(err?.message))
    }
  }

  return { ok: true, externalMediaId: published.id, permalink }
}

// ── Facebook Page ────────────────────────────────────────────────────────────

async function publishFacebookPage(
  pageId: string,
  token: string,
  post: any,
  media: MediaDescriptor[],
): Promise<PublishResult> {
  const message = fullCaption(post)

  let externalId: string

  if (post.content_type === 'text' || post.content_type === 'link') {
    const res = await metaGraph<{ id: string }>(`${pageId}/feed`, {
      method: 'POST',
      token,
      body: { message, ...(post.link_url ? { link: post.link_url } : {}) },
    })
    externalId = res.id
  } else if (post.content_type === 'image') {
    const res = await metaGraph<{ post_id?: string; id: string }>(`${pageId}/photos`, {
      method: 'POST',
      token,
      body: { url: media[0].url, message },
    })
    externalId = res.post_id || res.id
  } else if (post.content_type === 'carousel') {
    // Multi-photo: upload each unpublished, then attach to one feed post.
    const photoIds: string[] = []
    for (const item of media.filter((m) => m.type === 'image')) {
      const photo = await metaGraph<{ id: string }>(`${pageId}/photos`, {
        method: 'POST',
        token,
        body: { url: item.url, published: false },
      })
      photoIds.push(photo.id)
    }
    const res = await metaGraph<{ id: string }>(`${pageId}/feed`, {
      method: 'POST',
      token,
      body: {
        message,
        attached_media: photoIds.map((id) => ({ media_fbid: id })),
      },
    })
    externalId = res.id
  } else if (post.content_type === 'video' || post.content_type === 'reel') {
    const res = await metaGraph<{ id: string }>(`${pageId}/videos`, {
      method: 'POST',
      token,
      body: { file_url: media[0].url, description: message },
      timeoutMs: 120_000,
    })
    externalId = res.id
  } else {
    return { ok: false, error: `Facebook Pages do not support "${post.content_type}" via the API` }
  }

  let permalink: string | undefined
  try {
    const info = await metaGraph<{ permalink_url?: string }>(`${externalId}`, {
      token,
      params: { fields: 'permalink_url' },
      retries: 1,
    })
    permalink = info.permalink_url
  } catch { /* videos take time to be queryable — non-fatal */ }

  return { ok: true, externalMediaId: externalId, permalink }
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Publish one social_posts row NOW. Handles state transitions, retries
 * bookkeeping, cross-linking and notifications. Safe against double-fire: the
 * status CAS (scheduled/approved → publishing) makes concurrent runs no-op.
 */
export async function publishSocialPost(admin: SupabaseClient, postId: string): Promise<PublishResult> {
  const { data: post } = await admin
    .from('social_posts')
    .select('*, account:social_accounts(id, client_id, platform, external_id, access_token, connection_id, linked_page_account_id, publishing_enabled, status, name, username)')
    .eq('id', postId)
    .maybeSingle()
  if (!post) return { ok: false, error: 'Post not found' }

  const account = Array.isArray(post.account) ? post.account[0] : post.account
  if (!account) return { ok: false, error: 'Post has no account' }
  if (!account.publishing_enabled) return { ok: false, error: 'Publishing is disabled for this account' }

  // Claim the post (CAS) — only one publisher run may take it.
  const { data: claimed } = await admin
    .from('social_posts')
    .update({ status: 'publishing' })
    .eq('id', postId)
    .in('status', ['scheduled', 'approved'])
    .select('id')
    .maybeSingle()
  if (!claimed) return { ok: false, error: 'Post is not in a publishable state (already claimed?)' }

  // Resolve token: page token for FB; IG via linked page token, then connection.
  let token: string | null = null
  if (account.platform === 'facebook_page') {
    token = decryptToken(account.access_token)
  } else {
    if (account.linked_page_account_id) {
      const { data: page } = await admin
        .from('social_accounts')
        .select('access_token')
        .eq('id', account.linked_page_account_id)
        .maybeSingle()
      token = decryptToken(page?.access_token)
    }
    if (!token) token = decryptToken(account.access_token)
  }
  if (!token && account.connection_id) {
    const { data: conn } = await admin
      .from('provider_connections')
      .select('access_token, status')
      .eq('id', account.connection_id)
      .maybeSingle()
    if (conn?.status === 'active') token = decryptToken(conn.access_token)
  }

  const media: MediaDescriptor[] = Array.isArray(post.media) ? post.media : []

  let result: PublishResult
  if (!token) {
    result = { ok: false, error: 'No usable access token — reconnect the Meta account', authError: true }
  } else {
    try {
      result =
        account.platform === 'instagram'
          ? await publishInstagram(account.external_id, token, post, media)
          : await publishFacebookPage(account.external_id, token, post, media)
    } catch (err: any) {
      result = {
        ok: false,
        error: redactTokens(err?.message ?? 'Publish failed'),
        authError: err instanceof MetaApiError && err.isAuthError,
      }
    }
  }

  if (result.ok) {
    await admin
      .from('social_posts')
      .update({
        status: 'published',
        published_at: new Date().toISOString(),
        external_media_id: result.externalMediaId ?? null,
        permalink: result.permalink ?? null,
        publish_error: null,
      })
      .eq('id', postId)

    // Cross-link into the media registry so performance data attaches later.
    if (result.externalMediaId) {
      await admin
        .from('social_media_items')
        .upsert(
          {
            account_id: account.id,
            external_media_id: result.externalMediaId,
            media_product_type: post.content_type.startsWith('story')
              ? 'STORY'
              : post.content_type === 'reel'
                ? 'REELS'
                : 'FEED',
            caption: fullCaption(post) || null,
            permalink: result.permalink ?? null,
            posted_at: new Date().toISOString(),
            is_story: post.content_type.startsWith('story'),
            social_post_id: postId,
          },
          { onConflict: 'account_id,external_media_id' },
        )
        .then(null, () => {})
    }

    if (post.created_by) {
      await createNotification({
        employeeId: post.created_by,
        type: 'social_post_published',
        title: 'Post published',
        message: `${account.name || account.username || 'Account'} · ${post.content_type}`,
        link: '/dashboard/social/calendar',
        sourceKey: `post_published:${postId}`,
      })
    }
  } else {
    const attempts = (post.publish_attempts ?? 0) + 1
    const giveUp = attempts >= 3 || result.authError
    await admin
      .from('social_posts')
      .update({
        status: giveUp ? 'failed' : 'scheduled', // retry on next publisher run
        publish_attempts: attempts,
        publish_error: result.error ?? 'Publish failed',
      })
      .eq('id', postId)

    if (result.authError) {
      await admin
        .from('social_accounts')
        .update({ status: 'needs_reauth', last_error: result.error ?? null })
        .eq('id', account.id)
        .then(null, () => {})
    }

    if (giveUp) {
      await notifyAdmins({
        type: 'social_post_failed',
        title: 'Scheduled post failed',
        message: `${account.name || 'Account'} · ${result.error ?? 'Unknown error'}`.slice(0, 200),
        link: '/dashboard/social/calendar',
        sourceKey: `post_failed:${postId}`,
      })
    }
  }

  return result
}

/**
 * Delete a published post from Instagram or Facebook.
 *
 * IRREVERSIBLE. Meta keeps no undo: the post, its likes, its comments and its
 * permalink are gone, and reposting produces a new post with a new date and no
 * history. Callers must confirm with a human first.
 *
 * Instagram allows DELETE on media it published; Facebook allows it on Page
 * posts. Both need the same token that published the content, which is the one
 * already stored against the account.
 */
export async function deletePostFromMeta(
  admin: SupabaseClient,
  postId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data: post } = await admin
    .from('social_posts')
    .select('id, external_media_id, permalink, account_id, status')
    .eq('id', postId)
    .maybeSingle()
  if (!post) return { ok: false, error: 'Post not found.' }

  const externalId = (post as { external_media_id?: string | null }).external_media_id
  if (!externalId) {
    return { ok: false, error: 'This post was never published through Cirqle, so there is nothing on Meta to delete.' }
  }

  const { data: account } = await admin
    .from('social_accounts')
    .select('id, platform, external_id, access_token, connection_id, linked_page_account_id')
    .eq('id', (post as { account_id: string }).account_id)
    .maybeSingle()
  if (!account) return { ok: false, error: 'Account not found.' }

  const a = account as Record<string, string | null>
  let token = decryptToken(a.access_token)
  if (!token && a.linked_page_account_id) {
    const { data: page } = await admin
      .from('social_accounts').select('access_token').eq('id', a.linked_page_account_id).maybeSingle()
    token = decryptToken((page as { access_token?: string | null } | null)?.access_token)
  }
  if (!token && a.connection_id) {
    const { data: conn } = await admin
      .from('provider_connections').select('access_token, status').eq('id', a.connection_id).maybeSingle()
    const c = conn as { access_token?: string | null; status?: string } | null
    if (c?.status === 'active') token = decryptToken(c.access_token)
  }
  if (!token) return { ok: false, error: 'No usable access token — reconnect the Meta account.' }

  try {
    await metaGraph(`${externalId}`, { method: 'DELETE', token, retries: 1 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: redactTokens(msg) }
  }

  // Only after Meta confirms. Marking ours deleted first would leave a live
  // post nothing in Cirqle points at.
  await admin
    .from('social_posts')
    .update({ status: 'cancelled', deleted_at: new Date().toISOString() })
    .eq('id', postId)

  // The mirror row too, so the grid and the reports stop counting it.
  if (externalId) {
    await admin.from('social_media_items').delete().eq('external_media_id', externalId)
  }

  return { ok: true }
}
