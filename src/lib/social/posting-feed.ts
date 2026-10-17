/**
 * What goes into one person's posting calendar.
 *
 * Reads live alongside a possibly-unapplied migration: every column added by
 * 20261017090000 is probed, and its absence degrades the feed to "empty but
 * valid" rather than throwing. Same rule post-queue-load.ts follows — a
 * subscribed phone that gets a 500 shows the person nothing and tells them
 * nothing, which is worse than an empty calendar.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { columnExists } from '@/lib/supabase/server'
import { PERMS } from '@/lib/permissions/keys'
import { normalizeTime, postInstant } from './posting-time'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, 'public', any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export interface FeedPost {
  itemId: string
  clientName: string
  title: string
  isoDate: string
  /** 'HH:MM' on the business calendar. */
  time: string
  postAt: Date
  contentType: string | null
  platforms: string[]
  awaitingApproval: boolean
  cancelled: boolean
  updatedAt: Date | null
}

export interface PostingFeedResult {
  /** False when the migration has not been applied — the feed is empty, not broken. */
  ready: boolean
  posts: FeedPost[]
  /** True when this person sees every client's posts rather than only their own. */
  seesAll: boolean
}

/**
 * Does an employee hold a permission?
 *
 * loadCurrentUser() answers this for the SIGNED-IN user, and a calendar client
 * is not signed in — it presents a token and nothing else. So the designation
 * lookup is repeated here, pinned to one employee id, through the service role
 * for the same reason check.ts gives: authorization must not depend on the
 * grants it is deciding.
 */
async function employeeHasPermission(admin: Admin, employeeId: string, key: string): Promise<boolean> {
  const { data: emp } = await admin
    .from('employees')
    .select('designation_id, designation:designation_id(is_admin)')
    .eq('id', employeeId)
    .maybeSingle()
  if (!emp) return false

  const designation = Array.isArray((emp as Row).designation)
    ? (emp as Row).designation[0]
    : (emp as Row).designation
  if (designation?.is_admin) return true
  if (!(emp as Row).designation_id) return false

  const { data: dp } = await admin
    .from('designation_permissions')
    .select('allowed, permission:permission_id(key)')
    .eq('designation_id', (emp as Row).designation_id)
    .eq('allowed', true)
  return (dp ?? []).some((r: Row) => {
    const p = Array.isArray(r.permission) ? r.permission[0] : r.permission
    return p?.key === key
  })
}

/**
 * The timed posts one person should be reminded about.
 *
 * Who sees what: someone who holds social.publish sees every timed post,
 * because posting for all of them IS their job. Everyone else sees only what
 * is assigned to them, so a designer's phone does not buzz for a post they
 * have no part in.
 *
 * ASAP posts are deliberately absent. "Publish the moment it is approved" has
 * no moment to put on a calendar, and an alarm at an arbitrary time is the
 * kind of noise that gets a whole calendar muted — which would take the real
 * reminders down with it. They live in the posting view instead.
 */
export async function loadPostingFeed(
  admin: Admin,
  opts: { employeeId: string; fromISO: string; toISO: string },
): Promise<PostingFeedResult> {
  const hasTime = await columnExists(admin as never, 'social_calendar_items', 'scheduled_time')
  if (!hasTime) return { ready: false, posts: [], seesAll: false }

  const seesAll = await employeeHasPermission(admin, opts.employeeId, PERMS.SOCIAL_PUBLISH)
  const hasApprovalFlag = await columnExists(admin as never, 'clients', 'social_requires_approval')
  const hasPostedAt = await columnExists(admin as never, 'social_calendar_items', 'posted_at')

  let query = admin
    .from('social_calendar_items')
    .select(
      'id, title, scheduled_date, scheduled_time, content_type, platforms, status, ' +
      'assigned_employee_id, updated_at' + (hasPostedAt ? ', posted_at' : '') + ', ' +
      'calendar:calendar_id(client:client_id(name' + (hasApprovalFlag ? ', social_requires_approval' : '') + '))',
    )
    .gte('scheduled_date', opts.fromISO)
    .lte('scheduled_date', opts.toISO)
    .not('scheduled_time', 'is', null)

  // Everyone else gets only their own. Note this is an AND with the date range
  // above, not a replacement for it.
  if (!seesAll) query = query.eq('assigned_employee_id', opts.employeeId)

  const { data, error } = await query
  if (error) {
    console.warn('[posting-feed] query failed:', error.message)
    return { ready: true, posts: [], seesAll }
  }

  const posts: FeedPost[] = []
  for (const row of (data ?? []) as Row[]) {
    // A post already confirmed as published is history, not a reminder.
    if (hasPostedAt && row.posted_at) continue

    const time = normalizeTime(row.scheduled_time)
    if (!time) continue
    const postAt = postInstant(row.scheduled_date, time)
    if (!postAt) continue

    const calendar = Array.isArray(row.calendar) ? row.calendar[0] : row.calendar
    const client = Array.isArray(calendar?.client) ? calendar.client[0] : calendar?.client

    posts.push({
      itemId: String(row.id),
      clientName: client?.name ?? 'Client',
      title: String(row.title ?? 'Post'),
      isoDate: String(row.scheduled_date),
      time,
      postAt,
      contentType: row.content_type ?? null,
      platforms: Array.isArray(row.platforms) ? row.platforms : [],
      // Only a client who actually signs off blocks a post. Without the flag
      // column we say no rather than marking every post tentative, which would
      // make the distinction meaningless on every phone.
      awaitingApproval: Boolean(hasApprovalFlag && client?.social_requires_approval),
      cancelled: row.status === 'cancelled',
      updatedAt: row.updated_at ? new Date(row.updated_at) : null,
    })
  }

  posts.sort((a, b) => a.postAt.getTime() - b.postAt.getTime())
  return { ready: true, posts, seesAll }
}
