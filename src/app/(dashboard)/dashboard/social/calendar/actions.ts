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
import { publishSocialPost } from '@/lib/integrations/meta/publish'

const REVALIDATE = '/dashboard/social/calendar'

interface ActionResult<T = void> { ok: boolean; error?: string; warnings?: string[]; data?: T }

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
