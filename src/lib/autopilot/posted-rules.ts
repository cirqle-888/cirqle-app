/**
 * Rules for "posted work is done": match the planned posts that went to
 * Requests with what is actually live on the client's Instagram / Facebook
 * (social_media_items, filled by the daily Meta sync).
 *
 * Pure functions only; lib/autopilot/posted.ts reads the rows and acts.
 *
 * A planned post counts as posted when a post of the same kind (story, reel,
 * or feed post) went live on one of the client's connected accounts from the
 * day before its planned date to MATCH_AFTER days after it. Each live post
 * can prove only one planned post, the closest one in date, so two posters a
 * day apart cannot both be ticked off by the same upload.
 */
import { addDays } from './social-rules'

/** Days after the planned date a live post still counts (late posting). */
export const MATCH_AFTER = 3
/** Days before the planned date a live post still counts (posted early). */
export const MATCH_BEFORE = 1
/** How far back planned posts are checked. Older ones are left to a person. */
export const LOOKBACK_DAYS = 45

export type PostKind = 'story' | 'reel' | 'feed'

export interface PlannedPost {
  requestId: string
  ref: string
  clientId: string
  /** Planned date of the post (YYYY-MM-DD). */
  date: string
  /** social_calendar_items.content_type (post, poster, reel, story …). */
  contentType: string | null
  /** The request is already completed / cancelled (still uses up a live post). */
  closed: boolean
}

export interface LivePost {
  id: string
  clientId: string
  /** Day it went live on the India business calendar (YYYY-MM-DD). */
  day: string
  kind: PostKind
  permalink: string | null
}

/** What kind of live post a planned content type should become. */
export function plannedKind(contentType: string | null | undefined): PostKind | null {
  const t = (contentType || '').toLowerCase()
  if (t === 'story') return 'story'
  if (t === 'reel' || t === 'video') return 'reel'
  if (['post', 'poster', 'carousel', 'flyer', 'ad', 'other', ''].includes(t)) return 'feed'
  return null // blog, seo, email: never on Instagram
}

/** The kind of a synced media row (Meta's media_product_type / is_story). */
export function liveKind(row: { media_product_type?: string | null; is_story?: boolean | null; media_type?: string | null }): PostKind {
  if (row.is_story || (row.media_product_type || '').toUpperCase() === 'STORY') return 'story'
  if ((row.media_product_type || '').toUpperCase() === 'REELS') return 'reel'
  return 'feed'
}

/**
 * A reel may also show up as a plain video in the feed (Facebook reports
 * most videos without a product type), so a planned reel accepts a feed
 * post too, but a feed post never satisfies a story and the other way round.
 */
function kindFits(planned: PostKind, live: PostKind): boolean {
  if (planned === live) return true
  return planned === 'reel' && live === 'feed'
}

const dayGap = (a: string, b: string) =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000)

export interface PostedMatch { requestId: string; ref: string; post: LivePost }

/**
 * Pair planned posts with live posts. Closed requests take part (so their own
 * upload is not handed to another request) but are not returned.
 *
 * Planned posts are taken oldest first; each picks the unused live post of a
 * fitting kind nearest its date (an exact kind beats a reel-as-video, then the
 * smaller gap, then the earlier day).
 */
export function matchPosted(planned: PlannedPost[], live: LivePost[]): PostedMatch[] {
  const used = new Set<string>()
  const out: PostedMatch[] = []
  const ordered = [...planned].sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref))
  for (const p of ordered) {
    const want = plannedKind(p.contentType)
    if (!want) continue
    const from = addDays(p.date, -MATCH_BEFORE)
    const to = addDays(p.date, MATCH_AFTER)
    let best: LivePost | null = null
    let bestScore = Infinity
    for (const l of live) {
      if (used.has(l.id) || l.clientId !== p.clientId) continue
      if (l.day < from || l.day > to) continue
      if (!kindFits(want, l.kind)) continue
      const score = (l.kind === want ? 0 : 100) + Math.abs(dayGap(l.day, p.date)) * 2 + (l.day < p.date ? 1 : 0)
      if (score < bestScore) { best = l; bestScore = score }
    }
    if (!best) continue
    used.add(best.id)
    if (!p.closed) out.push({ requestId: p.requestId, ref: p.ref, post: best })
  }
  return out
}

/**
 * Open planned posts whose matching window is over with nothing live: these
 * need a person (posted somewhere we cannot see, or never posted).
 */
export function notSeenLive(planned: PlannedPost[], matched: Set<string>, connectedClients: Set<string>, today: string): PlannedPost[] {
  return planned
    .filter(p => !p.closed && !matched.has(p.requestId) && connectedClients.has(p.clientId))
    .filter(p => plannedKind(p.contentType) !== null && addDays(p.date, MATCH_AFTER) < today)
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** What to do with a matched request, from its task (if any). */
export type PostedAction = 'create_done_task' | 'mark_task_done' | 'sync_request' | 'none'

export function actionFor(task: { status: string; deleted_at?: string | null } | null): PostedAction {
  if (!task || task.deleted_at) return 'create_done_task'
  if (['pending', 'in_progress', 'delivered'].includes(task.status)) return 'mark_task_done'
  if (['done', 'invoiced', 'paid'].includes(task.status)) return 'sync_request'
  return 'none' // cancelled: someone decided; leave it
}
