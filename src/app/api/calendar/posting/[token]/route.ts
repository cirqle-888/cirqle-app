import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadPostingFeed } from '@/lib/social/posting-feed'
import { buildCalendar, postingEvent } from '@/lib/social/ics'
import { DEFAULT_REMINDER_MINUTES } from '@/lib/social/posting-time'
import { looksLikeFeedToken } from '@/lib/social/feed-token'
import { todayISO, addDaysISO } from '@/lib/utils/local-date'

/**
 * GET /api/calendar/posting/[token] — one person's posting calendar, as .ics.
 *
 * The whole point of the feature. Nothing on this plan can fire a reminder 15
 * minutes before a posting time: every cron here is daily, because Vercel
 * Hobby allows nothing faster, and native push has no APNs/FCM credentials
 * yet. So the server stops trying to be awake at the right minute — it hands
 * the phone a calendar, and the phone's own alarm does the work, offline, on
 * the lock screen.
 *
 * ── Auth is the URL ────────────────────────────────────────────────────────
 *
 * A calendar client sends no cookie and no Authorization header; it just GETs
 * a URL on a schedule it chooses. So the token IS the credential, and this
 * route is deliberately the only unauthenticated read of posting data in the
 * app. What that buys the holder of a leaked URL is bounded on purpose:
 * titles, times and client names for ONE employee's posts in a 10-week
 * window. No captions, no media, no links to anything that is not already
 * behind a login. Revoke by nulling employees.calendar_feed_token.
 *
 * An unknown token returns 404 with no body — the same answer as a token that
 * was revoked, so the response never confirms that a token was ever valid.
 */

export const dynamic = 'force-dynamic'

/** Narrow enough to be a reminder, wide enough that a phone never shows a gap. */
const PAST_DAYS = 14
const FUTURE_DAYS = 56

const notFound = () => new NextResponse(null, { status: 404 })

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  // Cheap shape check before touching the database: a real token is a long
  // random string, so anything else is a scan, not a subscriber. The rule
  // lives with the generator so the two cannot drift apart.
  if (!looksLikeFeedToken(token)) return notFound()

  const admin = createAdminClient()

  const { data: employee, error } = await admin
    .from('employees')
    .select('id, name')
    .eq('calendar_feed_token', token)
    .maybeSingle()

  // A missing column (migration not yet applied) lands here too, and 404 is
  // the right answer for it: there is no feed to serve yet.
  if (error || !employee) return notFound()

  const today = todayISO()
  const feed = await loadPostingFeed(admin, {
    employeeId: String(employee.id),
    fromISO: addDaysISO(today, -PAST_DAYS),
    toISO: addDaysISO(today, FUTURE_DAYS),
  })

  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || 'https://app.cirqle.work'
  const ics = buildCalendar(
    feed.posts.map(p => postingEvent({
      itemId: p.itemId,
      clientName: p.clientName,
      title: p.title,
      postAt: p.postAt,
      contentType: p.contentType,
      platforms: p.platforms,
      url: `${base}/dashboard/social/queue`,
      awaitingApproval: p.awaitingApproval,
      cancelled: p.cancelled,
      updatedAt: p.updatedAt,
      reminderMinutes: DEFAULT_REMINDER_MINUTES,
    })),
    {
      name: feed.seesAll ? 'Cirqle — Posting times' : `Cirqle — ${employee.name ?? 'My'} posting times`,
      description: feed.ready
        ? 'Every planned post with a 15-minute alarm. Managed in Cirqle — edits here are overwritten.'
        : 'Posting times are not switched on yet. This calendar will fill once they are.',
      refreshMinutes: 60,
    },
  )

  return new NextResponse(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      // Named so a manual download is recognisable in a Downloads folder.
      'Content-Disposition': 'inline; filename="cirqle-posting.ics"',
      // private + no-store: the URL is a bearer credential, and a shared cache
      // holding one person's calendar is exactly the wrong thing to have.
      // Phones re-fetch on their own schedule regardless.
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}
