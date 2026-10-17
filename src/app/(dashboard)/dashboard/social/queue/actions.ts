'use server'

/**
 * Posting queue — server actions.
 *
 * These cover the MANUAL path, which is how posting actually happens today:
 * she writes the caption here, posts natively on Instagram, and records it. The
 * API path (schedule / publish now) already exists in the calendar actions and
 * is reused unchanged rather than reimplemented — this file never talks to
 * Meta.
 *
 * A social_posts row is created lazily, on her first keystroke, so an untouched
 * queue leaves no rows behind.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { revalidatePath } from 'next/cache'
import { postContentTypeFor } from '@/lib/social-hub/post-queue'
import { columnExists } from '@/lib/supabase/server'
import { newFeedToken, looksLikeFeedToken, feedUrl } from '@/lib/social/feed-token'
import { headers } from 'next/headers'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export interface QueueContentPayload {
  caption?: string | null
  hashtags?: string | null
  alt_text?: string | null
  first_comment?: string | null
}

/** Look up the calendar item's client + content type, which the post row needs. */
async function itemContext(admin: ReturnType<typeof createAdminClient>, itemId: string) {
  const { data } = await admin
    .from('social_calendar_items')
    .select('id, content_type, calendar:social_calendars(client_id)')
    .eq('id', itemId)
    .maybeSingle()
  if (!data) return null
  const d = data as unknown as Row
  const cal = Array.isArray(d.calendar) ? d.calendar[0] : d.calendar
  if (!cal?.client_id) return null
  // Translated, never copied: the calendar's vocabulary ('post', 'poster',
  // 'flyer') is not the one social_posts' CHECK constraint accepts.
  return { clientId: cal.client_id as string, contentType: postContentTypeFor(d.content_type as string) }
}

/**
 * Create-or-update the post attached to a calendar item.
 *
 * account_id is left NULL: she has not chosen where it goes, and for a manual
 * post she may never need to. The publisher only reads status='scheduled', so a
 * row without an account can never be picked up by the cron.
 */
export async function savePostContent(
  itemId: string,
  payload: QueueContentPayload,
): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.SOCIAL_PUBLISH)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!itemId) return { ok: false, error: 'Missing item.' }

  const admin = createAdminClient()

  const { data: existing } = await admin
    .from('social_posts')
    .select('id, status')
    .eq('calendar_item_id', itemId)
    .is('deleted_at', null)
    .maybeSingle()

  const fields = {
    caption: payload.caption ?? null,
    hashtags: payload.hashtags ?? null,
    alt_text: payload.alt_text ?? null,
    first_comment: payload.first_comment ?? null,
    updated_at: new Date().toISOString(),
  }

  if (existing) {
    const { error } = await admin.from('social_posts').update(fields).eq('id', existing.id)
    if (error) return { ok: false, error: error.message }
    revalidatePath('/dashboard/social/queue')
    revalidatePath('/dashboard/my-work')
    return { ok: true, data: { id: (existing as Row).id } }
  }

  const ctx = await itemContext(admin, itemId)
  if (!ctx) return { ok: false, error: 'Planned item not found.' }

  const { data, error } = await admin
    .from('social_posts')
    .insert({
      client_id: ctx.clientId,
      calendar_item_id: itemId,
      content_type: ctx.contentType,
      status: 'draft',
      created_by: guard.employeeId ?? null,
      ...fields,
    })
    .select('id')
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/social/queue')
  revalidatePath('/dashboard/my-work')
  return { ok: true, data: { id: (data as Row)?.id } }
}

/**
 * Record that a post went out by hand.
 *
 * Writes published_at + posted_manually so reporting can tell a real manual
 * post from an API publish. Creates the row if she never opened the editor —
 * ticking "posted" on something with no caption is legitimate: the caption may
 * have been written in Instagram itself.
 */
export async function markAsPosted(
  itemId: string,
  whenIso?: string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_PUBLISH)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const when = whenIso || new Date().toISOString()

  const { data: existing } = await admin
    .from('social_posts')
    .select('id')
    .eq('calendar_item_id', itemId)
    .is('deleted_at', null)
    .maybeSingle()

  if (existing) {
    const { error } = await admin
      .from('social_posts')
      .update({
        status: 'published', published_at: when, posted_manually: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', (existing as Row).id)
    if (error) return { ok: false, error: error.message }
  } else {
    const ctx = await itemContext(admin, itemId)
    if (!ctx) return { ok: false, error: 'Planned item not found.' }
    const { error } = await admin.from('social_posts').insert({
      client_id: ctx.clientId,
      calendar_item_id: itemId,
      content_type: ctx.contentType,
      status: 'published',
      published_at: when,
      posted_manually: true,
      created_by: guard.employeeId ?? null,
    })
    if (error) return { ok: false, error: error.message }
  }

  // entityType 'task' on purpose — activity_logs.project_id carries an FK that
  // silently rejects rows written with an entity type it does not know.
  await logActivity({
    action: 'social_post_marked_posted',
    entityType: 'task',
    entityId: itemId,
    detail: { posted_at: when, manual: true },
  }).catch(() => {})

  revalidatePath('/dashboard/social/queue')
  revalidatePath('/dashboard/my-work')
  return { ok: true }
}

/** Undo a mistaken "posted" tick. Keeps the caption — only the posting is undone. */
export async function unmarkPosted(itemId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_PUBLISH)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: existing } = await admin
    .from('social_posts')
    .select('id, external_media_id')
    .eq('calendar_item_id', itemId)
    .is('deleted_at', null)
    .maybeSingle()
  if (!existing) return { ok: true }

  // A post that really went out through the API has a Meta id. Un-ticking that
  // would claim something false about a live post, so it is refused.
  if ((existing as Row).external_media_id) {
    return { ok: false, error: 'This was published through Cirqle and is live — it cannot be un-marked.' }
  }

  const { error } = await admin
    .from('social_posts')
    .update({ status: 'draft', published_at: null, posted_manually: false })
    .eq('id', (existing as Row).id)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/dashboard/social/queue')
  revalidatePath('/dashboard/my-work')
  return { ok: true }
}

/** Turn the posting queue on or off for one client. */
export async function setClientPublishing(
  clientId: string,
  enabled: boolean,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('clients')
    .update({ has_social_media_service: enabled })
    .eq('id', clientId)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/dashboard/social/queue')
  return { ok: true }
}

// ── The subscribable posting calendar ────────────────────────────────────────
// Why this exists at all: nothing on this plan can fire a reminder 15 minutes
// before a posting time. Every cron is daily (Vercel Hobby allows nothing
// faster — see api/cron/interview-reminders) and native push has no APNs/FCM
// credentials yet (native-push.ts). So the alarm is the subscriber's phone,
// and these actions hand them the URL to subscribe to.

export interface CalendarFeedInfo {
  /** What a phone should subscribe to. */
  webcalUrl: string
  /** The same feed over https, for anything that refuses webcal://. */
  httpsUrl: string
  /** False when this is a freshly minted token rather than an existing one. */
  existing: boolean
}

/**
 * This person's calendar subscription URL, minting one on first use.
 *
 * Gated on social.view, not social.publish: a designer who gets assigned a
 * post should be reminded about it too, and their feed only ever contains what
 * is assigned to them (see loadPostingFeed).
 *
 * Minted lazily and never backfilled — a feed nobody asked for would be a live
 * secret sitting in the database for no reason.
 */
export async function myCalendarFeed(): Promise<ActionResult<CalendarFeedInfo>> {
  const guard = await requirePermission(PERMS.SOCIAL_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!guard.employeeId) return { ok: false, error: 'No employee record for this account.' }

  const admin = createAdminClient()
  if (!(await columnExists(admin, 'employees', 'calendar_feed_token'))) {
    return { ok: false, error: 'Posting calendars are not switched on yet — the database migration has not been applied.' }
  }

  const { data: me, error: readErr } = await admin
    .from('employees')
    .select('calendar_feed_token')
    .eq('id', guard.employeeId)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }

  let token = (me as Row | null)?.calendar_feed_token as string | null | undefined
  const existing = looksLikeFeedToken(token)
  if (!existing) {
    token = newFeedToken()
    const { error } = await admin
      .from('employees')
      .update({ calendar_feed_token: token })
      .eq('id', guard.employeeId)
    if (error) return { ok: false, error: error.message }
  }

  const hdrs = await headers()
  const host = hdrs.get('host') || ''
  const isLocal = host.startsWith('localhost') || host.startsWith('127.')
  const proto = hdrs.get('x-forwarded-proto') || (isLocal ? 'http' : 'https')
  const origin = host ? `${proto}://${host}` : (process.env.NEXT_PUBLIC_SITE_URL || 'https://app.cirqle.work')

  return {
    ok: true,
    data: {
      webcalUrl: feedUrl(origin, token!),
      httpsUrl: feedUrl(origin, token!, { webcal: false }),
      existing,
    },
  }
}

/**
 * Revoke the feed. Every device subscribed to the old URL starts getting 404s
 * immediately, which is the correct response to a URL having been shared by
 * accident — the URL is the whole credential.
 */
export async function revokeMyCalendarFeed(): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!guard.employeeId) return { ok: false, error: 'No employee record for this account.' }

  const admin = createAdminClient()
  if (!(await columnExists(admin, 'employees', 'calendar_feed_token'))) return { ok: true }

  const { error } = await admin
    .from('employees')
    .update({ calendar_feed_token: null })
    .eq('id', guard.employeeId)
  if (error) return { ok: false, error: error.message }

  await logActivity({
    action: 'social_calendar_feed_revoked',
    entityType: 'task',
    entityId: guard.employeeId,
    detail: {},
  }).catch(() => {})

  return { ok: true }
}
