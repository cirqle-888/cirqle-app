'use server'

/**
 * Social calendar / composer — server actions.
 *
 * The publishing pipeline lives in src/lib/integrations/meta/publish.ts; these
 * actions manage the social_posts workflow rows and re-validate every draft
 * server-side with the shared validator so the client can never persist content
 * Meta would reject.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { revalidatePath } from 'next/cache'
import { validateSocialPost, type MediaDescriptor, type SocialContentType, type SocialPlatform } from '@/lib/social-hub/validation'
import { publishSocialPost, deletePostFromMeta } from '@/lib/integrations/meta/publish'

const REVALIDATE = '/dashboard/social/calendar'

interface ActionResult<T = void> { ok: boolean; error?: string; warnings?: string[]; data?: T }

/** A PostgREST row whose shape is known but not expressible in the generated
 *  types. One narrow alias beats scattering `any`. */
type Row = Record<string, unknown> & { [k: string]: any }   // eslint-disable-line @typescript-eslint/no-explicit-any

export interface PostPayload {
  id?: string | null
  /** NULL for one of Cirqle's own accounts, which have no client by design. */
  client_id: string | null
  account_id: string
  content_type: SocialContentType
  caption?: string | null
  hashtags?: string | null
  first_comment?: string | null
  link_url?: string | null
  media?: MediaDescriptor[]
  cover_url?: string | null
  share_to_feed?: boolean
  scheduled_at?: string | null
  designer_id?: string | null
  assigned_to?: string | null
}

/** Load the account's platform so validation runs against the right rules. */
async function accountPlatform(admin: ReturnType<typeof createAdminClient>, accountId: string): Promise<SocialPlatform | null> {
  const { data } = await admin.from('social_accounts').select('platform').eq('id', accountId).maybeSingle()
  return (data?.platform as SocialPlatform) ?? null
}

function validateOrReject(platform: SocialPlatform, p: PostPayload): { error?: string; warnings: string[] } {
  const result = validateSocialPost({
    platform,
    contentType: p.content_type,
    caption: p.caption,
    hashtags: p.hashtags,
    firstComment: p.first_comment,
    linkUrl: p.link_url,
    media: p.media ?? [],
    scheduledAt: p.scheduled_at,
  })
  if (!result.ok) return { error: result.errors[0], warnings: result.warnings }
  return { warnings: result.warnings }
}

export async function createSocialPost(p: PostPayload, intent: 'draft' | 'approval' = 'draft'): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.SOCIAL_PUBLISH)
  if (!guard.ok) return { ok: false, error: guard.error }
  // No client check: social_posts.client_id is nullable precisely because our
  // own accounts have none. The account is what a post actually needs.
  if (!p.account_id) return { ok: false, error: 'Pick an account.' }

  const admin = createAdminClient()
  const platform = await accountPlatform(admin, p.account_id)
  if (!platform) return { ok: false, error: 'Account not found.' }

  const { error: vErr, warnings } = validateOrReject(platform, p)
  if (vErr) return { ok: false, error: vErr }

  const status = intent === 'approval' ? 'awaiting_approval' : 'draft'
  const { data, error } = await admin
    .from('social_posts')
    .insert({
      client_id: p.client_id,
      account_id: p.account_id,
      content_type: p.content_type,
      status,
      caption: p.caption ?? null,
      hashtags: p.hashtags ?? null,
      first_comment: p.first_comment ?? null,
      link_url: p.link_url ?? null,
      media: p.media ?? [],
      cover_url: p.cover_url ?? null,
      share_to_feed: p.share_to_feed ?? true,
      scheduled_at: p.scheduled_at ?? null,
      designer_id: p.designer_id ?? null,
      assigned_to: p.assigned_to ?? null,
      created_by: guard.employeeId ?? null,
    })
    .select('id')
    .single()
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId: guard.employeeId, entityType: 'client', entityId: p.client_id, clientId: p.client_id,
    action: 'created', category: 'crm',
    detail: [{ field: 'social_post', from: null, to: { content_type: p.content_type, status } }],
  })
  revalidatePath(REVALIDATE)
  return { ok: true, warnings, data: { id: (data as { id: string }).id } }
}

export async function updateSocialPost(id: string, p: PostPayload): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_PUBLISH)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: before } = await admin.from('social_posts').select('id, client_id, status').eq('id', id).maybeSingle()
  if (!before) return { ok: false, error: 'Post not found.' }
  // Only editable while not already published/publishing.
  if (['published', 'publishing'].includes(before.status)) return { ok: false, error: 'A published post cannot be edited.' }

  const platform = await accountPlatform(admin, p.account_id)
  if (!platform) return { ok: false, error: 'Account not found.' }
  const { error: vErr } = validateOrReject(platform, p)
  if (vErr) return { ok: false, error: vErr }

  const { error } = await admin
    .from('social_posts')
    .update({
      account_id: p.account_id,
      content_type: p.content_type,
      caption: p.caption ?? null,
      hashtags: p.hashtags ?? null,
      first_comment: p.first_comment ?? null,
      link_url: p.link_url ?? null,
      media: p.media ?? [],
      cover_url: p.cover_url ?? null,
      share_to_feed: p.share_to_feed ?? true,
      scheduled_at: p.scheduled_at ?? null,
      designer_id: p.designer_id ?? null,
      assigned_to: p.assigned_to ?? null,
    })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }

  void logActivity({ actorId: guard.employeeId, entityType: 'client', entityId: before.client_id, clientId: before.client_id, action: 'edited', category: 'crm', detail: [{ field: 'social_post', from: id, to: 'updated' }] })
  revalidatePath(REVALIDATE)
  return { ok: true }
}

export async function submitForApproval(id: string): Promise<ActionResult> {
  return setStatus(id, 'awaiting_approval', PERMS.SOCIAL_PUBLISH)
}

export async function approvePost(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_APPROVE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { data: post } = await admin.from('social_posts').select('id, client_id, scheduled_at').eq('id', id).maybeSingle()
  if (!post) return { ok: false, error: 'Post not found.' }
  // If a schedule is set, approving moves it into the publisher queue; else it
  // becomes 'approved' (publish now, or schedule later).
  const nextStatus = post.scheduled_at ? 'scheduled' : 'approved'
  const { error } = await admin
    .from('social_posts')
    .update({ status: nextStatus, approved_by: guard.employeeId ?? null, approved_at: new Date().toISOString() })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }
  void logActivity({ actorId: guard.employeeId, entityType: 'client', entityId: post.client_id, clientId: post.client_id, action: 'edited', category: 'crm', detail: [{ field: 'social_post', from: 'awaiting_approval', to: nextStatus }] })
  revalidatePath(REVALIDATE)
  return { ok: true }
}

export async function schedulePost(id: string, whenIso: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_APPROVE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (new Date(whenIso).getTime() < Date.now() + 5 * 60_000) return { ok: false, error: 'Schedule at least 5 minutes ahead.' }
  const admin = createAdminClient()
  const { data: post } = await admin.from('social_posts').select('id, client_id, status').eq('id', id).maybeSingle()
  if (!post) return { ok: false, error: 'Post not found.' }
  const { error } = await admin.from('social_posts').update({ scheduled_at: whenIso, status: 'scheduled' }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  void logActivity({ actorId: guard.employeeId, entityType: 'client', entityId: post.client_id, clientId: post.client_id, action: 'edited', category: 'crm', detail: [{ field: 'social_post_scheduled', from: post.status, to: whenIso }] })
  revalidatePath(REVALIDATE)
  return { ok: true }
}

export async function publishPostNow(id: string): Promise<ActionResult<{ permalink?: string }>> {
  const guard = await requirePermission(PERMS.SOCIAL_APPROVE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { data: post } = await admin.from('social_posts').select('id, client_id, status').eq('id', id).maybeSingle()
  if (!post) return { ok: false, error: 'Post not found.' }

  // Move into a publishable state, then publish inline.
  await admin
    .from('social_posts')
    .update({ status: 'approved', approved_by: guard.employeeId ?? null, approved_at: new Date().toISOString(), scheduled_at: null })
    .eq('id', id)
    .in('status', ['draft', 'awaiting_approval', 'approved', 'scheduled', 'failed'])

  const result = await publishSocialPost(admin, id)
  void logActivity({ actorId: guard.employeeId, entityType: 'client', entityId: post.client_id, clientId: post.client_id, action: 'edited', category: 'crm', detail: [{ field: 'social_post_published', from: post.status, to: result.ok ? 'published' : 'failed' }] })
  revalidatePath(REVALIDATE)
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, data: { permalink: result.permalink } }
}

export async function cancelPost(id: string): Promise<ActionResult> {
  return setStatus(id, 'cancelled', PERMS.SOCIAL_PUBLISH)
}

export async function deletePost(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_PUBLISH)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { data: post } = await admin.from('social_posts').select('id, client_id').eq('id', id).maybeSingle()
  if (!post) return { ok: false, error: 'Post not found.' }
  const { error } = await admin.from('social_posts').update({ deleted_at: new Date().toISOString() }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  void logActivity({ actorId: guard.employeeId, entityType: 'client', entityId: post.client_id, clientId: post.client_id, action: 'deleted', category: 'crm', detail: [{ field: 'social_post', from: id, to: null }] })
  revalidatePath(REVALIDATE)
  return { ok: true }
}

async function setStatus(id: string, status: string, perm: string): Promise<ActionResult> {
  const guard = await requirePermission(perm)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { data: post } = await admin.from('social_posts').select('id, client_id, status').eq('id', id).maybeSingle()
  if (!post) return { ok: false, error: 'Post not found.' }
  const { error } = await admin.from('social_posts').update({ status }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  void logActivity({ actorId: guard.employeeId, entityType: 'client', entityId: post.client_id, clientId: post.client_id, action: 'edited', category: 'crm', detail: [{ field: 'social_post_status', from: post.status, to: status }] })
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * Create a signed upload URL for post media. The browser uploads directly to
 * the public 'social-media' bucket; we return the public URL Meta will fetch.
 */
/**
 * @param clientId Storage namespace. NULL is legitimate and means one of
 *   Cirqle's OWN accounts (social_accounts.owner_type = 'cirqle'), which have
 *   no client and never will — those files land under `cirqle/` instead. A
 *   client-owned account that is genuinely unassigned is rejected by the
 *   caller, which can tell the two apart; this function cannot.
 */
export async function createSignedMediaUpload(
  clientId: string | null,
  fileName: string,
): Promise<ActionResult<{ path: string; token: string; publicUrl: string }>> {
  const guard = await requirePermission(PERMS.SOCIAL_PUBLISH)
  if (!guard.ok) return { ok: false, error: guard.error }

  const ext = (fileName.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '')
  const path = `${clientId || 'cirqle'}/${crypto.randomUUID()}.${ext}`
  const admin = createAdminClient()
  const { data, error } = await admin.storage.from('social-media').createSignedUploadUrl(path)
  if (error || !data) return { ok: false, error: error?.message || 'Could not create upload URL.' }
  const { data: pub } = admin.storage.from('social-media').getPublicUrl(path)
  return { ok: true, data: { path: data.path, token: data.token, publicUrl: pub.publicUrl } }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Cross-posting
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CrossPostOutcome {
  accountId: string
  accountLabel: string
  ok: boolean
  /** Present when this account was skipped or failed, in plain words. */
  error?: string
  postId?: string
  permalink?: string
}

/**
 * Publish one piece of content to several accounts at once.
 *
 * Instagram and Facebook are separate accounts on separate platforms, so this
 * genuinely is several posts — Meta offers no single call for both. What it
 * removes is retyping the caption and re-uploading the media, and the risk of
 * the two drifting apart.
 *
 * EACH ACCOUNT IS VALIDATED ON ITS OWN RULES, and an account that cannot take
 * this content is SKIPPED rather than failing the batch: a link post is fine
 * on a Page and impossible on Instagram, and discovering that should not cost
 * you the Facebook post too. The caller is told exactly which went and which
 * did not.
 */
export async function crossPost(
  p: PostPayload,
  accountIds: string[],
  intent: 'draft' | 'approval' | 'approve' | 'publish',
): Promise<ActionResult<{ outcomes: CrossPostOutcome[] }>> {
  const needsApprove = intent === 'approve' || intent === 'publish'
  const guard = await requirePermission(needsApprove ? PERMS.SOCIAL_APPROVE : PERMS.SOCIAL_PUBLISH)
  if (!guard.ok) return { ok: false, error: guard.error }

  const unique = [...new Set(accountIds.filter(Boolean))]
  if (unique.length === 0) return { ok: false, error: 'Pick at least one account.' }

  const admin = createAdminClient()
  const { data: accounts } = await admin
    .from('social_accounts')
    .select('id, platform, name, username, publishing_enabled, status')
    .in('id', unique)

  const byId = new Map((accounts ?? []).map((a: Row) => [a.id as string, a]))
  const outcomes: CrossPostOutcome[] = []

  for (const accountId of unique) {
    const account = byId.get(accountId)
    const label = account
      ? `${account.platform === 'instagram' ? 'IG' : 'FB'} · ${account.username ?? account.name}`
      : accountId
    if (!account) {
      outcomes.push({ accountId, accountLabel: label, ok: false, error: 'Account not found.' })
      continue
    }
    if (account.status === 'disconnected' || account.publishing_enabled === false) {
      outcomes.push({ accountId, accountLabel: label, ok: false, error: 'Publishing is off for this account.' })
      continue
    }

    const platform = account.platform as SocialPlatform
    const { error: vErr } = validateOrReject(platform, p)
    if (vErr) {
      // Not a failure of the batch — this platform simply cannot take it.
      outcomes.push({ accountId, accountLabel: label, ok: false, error: vErr })
      continue
    }

    const created = await createSocialPost(
      { ...p, id: null, account_id: accountId },
      intent === 'approval' ? 'approval' : 'draft',
    )
    if (!created.ok || !created.data?.id) {
      outcomes.push({ accountId, accountLabel: label, ok: false, error: created.error ?? 'Could not save.' })
      continue
    }
    const postId = created.data.id

    if (intent === 'approve') {
      const res = await approvePost(postId)
      outcomes.push({ accountId, accountLabel: label, ok: res.ok, error: res.error, postId })
    } else if (intent === 'publish') {
      const res = await publishPostNow(postId)
      outcomes.push({
        accountId, accountLabel: label, ok: res.ok, error: res.error, postId,
        permalink: res.data?.permalink,
      })
    } else {
      outcomes.push({ accountId, accountLabel: label, ok: true, postId })
    }
  }

  revalidatePath(REVALIDATE)
  const anyOk = outcomes.some(o => o.ok)
  return anyOk
    ? { ok: true, data: { outcomes } }
    : { ok: false, error: outcomes[0]?.error ?? 'Nothing could be posted.', data: { outcomes } }
}

/**
 * Remove a live post from Instagram or Facebook.
 *
 * Separate from deletePost, which only removes Cirqle's record and leaves the
 * post up. This one is IRREVERSIBLE on the client's real account — likes,
 * comments and the permalink go with it — so it is gated on social.approve,
 * the same permission as publishing, rather than on social.publish.
 */
export async function deleteFromMeta(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_APPROVE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: post } = await admin
    .from('social_posts').select('id, client_id, account_id, permalink').eq('id', id).maybeSingle()
  if (!post) return { ok: false, error: 'Post not found.' }

  const res = await deletePostFromMeta(admin, id)
  if (!res.ok) return { ok: false, error: res.error }

  const p = post as Row
  void logActivity({
    actorId: guard.employeeId,
    entityType: p.client_id ? 'client' : 'social_account',
    entityId: (p.client_id ?? p.account_id) as string,
    clientId: (p.client_id ?? null) as string | null,
    category: 'crm', action: 'social_post_deleted_from_meta',
    detail: { permalink: p.permalink ?? null },
  }).catch(() => {})

  revalidatePath(REVALIDATE)
  return { ok: true }
}
