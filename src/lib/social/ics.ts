/**
 * iCalendar (RFC 5545) output — pure, no Supabase, unit-tested.
 *
 * ── Why the calendar and not a notification ─────────────────────────────────
 *
 * The reminder has to fire 15 minutes before a posting time. Nothing on the
 * server can do that: every cron in this app is daily, because Vercel Hobby
 * only supports daily-or-slower schedules (see api/cron/interview-reminders).
 * Native push would need the APNs/FCM credentials that native-push.ts says are
 * still not set up.
 *
 * So the server stops trying to be awake at the right minute. It hands each
 * person a calendar they subscribe to once, and their phone fires the alarm —
 * locally, offline, on the lock screen, on iOS and Android alike. The only
 * thing that has to be on time is the phone, which already is.
 *
 * ── The parts that are easy to get wrong ────────────────────────────────────
 *
 * UIDs are stable per post, so re-publishing the feed UPDATES an event instead
 * of adding a second one. SEQUENCE rises with the post's updated_at, which is
 * what tells a subscribed client the event changed at all. A cancelled post is
 * emitted as STATUS:CANCELLED rather than dropped, because a client that
 * simply stops seeing an event may keep showing it forever.
 *
 * Times go out as UTC (`...Z`). The alternative is shipping a VTIMEZONE block
 * for Asia/Kolkata and trusting every client to apply it; a UTC instant is the
 * same moment everywhere and cannot be misread.
 */

/** Folding counts octets, so the limit is on the UTF-8 encoding, not characters. */
const MAX_OCTETS = 75

export interface IcsAlarm {
  /** Minutes before the start. 0 means at the moment itself. */
  minutesBefore: number
  description: string
}

export interface IcsEvent {
  /** Stable across regenerations — the post's id, not a random value. */
  uid: string
  start: Date
  /** Defaults to a 15-minute block from `start`. */
  end?: Date
  summary: string
  description?: string
  url?: string
  /** 1–9, RFC 5545: 1 is the highest. Omitted when undefined. */
  priority?: number
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED'
  categories?: string[]
  /** Rises when the event changes; subscribers ignore an unchanged SEQUENCE. */
  sequence?: number
  alarms?: IcsAlarm[]
  /** When this version of the event was produced. Defaults to now. */
  stamp?: Date
}

export interface IcsCalendarOptions {
  /** Shown as the calendar's name in the phone's calendar list. */
  name: string
  description?: string
  /** How often a subscribed client should re-fetch. Default 1 hour. */
  refreshMinutes?: number
  /** Overridden in tests so output is deterministic. */
  now?: Date
}

// ── Primitives ───────────────────────────────────────────────────────────────

/**
 * Escape a TEXT value. Order matters: backslashes first, or the escapes we
 * add below get escaped again.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
}

/**
 * Fold a content line to 75 octets, continuing with a leading space.
 *
 * Splits on encoded length rather than string length, and never between the
 * bytes of one character — a multi-byte emoji cut in half makes the whole
 * calendar unparseable in Apple Calendar.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= MAX_OCTETS) return line

  const out: string[] = []
  let current = ''
  let octets = 0
  // First line gets 75; continuations lose one octet to the leading space.
  let budget = MAX_OCTETS

  for (const char of line) {
    const size = encoder.encode(char).length
    if (octets + size > budget) {
      out.push(current)
      current = ''
      octets = 0
      budget = MAX_OCTETS - 1
    }
    current += char
    octets += size
  }
  if (current) out.push(current)
  return out.map((part, i) => (i === 0 ? part : ` ${part}`)).join('\r\n')
}

/** RFC 5545 UTC form: 20261019T140000Z. */
export function formatUtc(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  )
}

/** Minutes → an RFC 5545 duration, e.g. -PT15M. 0 → PT0S. */
export function triggerDuration(minutesBefore: number): string {
  const m = Math.max(0, Math.trunc(minutesBefore))
  if (m === 0) return 'PT0S'
  const hours = Math.floor(m / 60)
  const mins = m % 60
  return `-PT${hours ? `${hours}H` : ''}${mins ? `${mins}M` : ''}`
}

// ── Assembly ─────────────────────────────────────────────────────────────────

function eventLines(ev: IcsEvent, now: Date): string[] {
  const end = ev.end ?? new Date(ev.start.getTime() + 15 * 60_000)
  const lines: string[] = [
    'BEGIN:VEVENT',
    `UID:${escapeText(ev.uid)}`,
    `DTSTAMP:${formatUtc(ev.stamp ?? now)}`,
    `DTSTART:${formatUtc(ev.start)}`,
    `DTEND:${formatUtc(end)}`,
    `SUMMARY:${escapeText(ev.summary)}`,
    `SEQUENCE:${Math.max(0, Math.trunc(ev.sequence ?? 0))}`,
    `STATUS:${ev.status ?? 'CONFIRMED'}`,
    // The post itself takes a minute — it should never make someone look busy.
    'TRANSP:TRANSPARENT',
  ]
  if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`)
  if (ev.url) lines.push(`URL:${escapeText(ev.url)}`)
  if (ev.categories?.length) lines.push(`CATEGORIES:${ev.categories.map(escapeText).join(',')}`)
  if (typeof ev.priority === 'number') {
    lines.push(`PRIORITY:${Math.min(9, Math.max(1, Math.trunc(ev.priority)))}`)
  }

  for (const alarm of ev.alarms ?? []) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `TRIGGER:${triggerDuration(alarm.minutesBefore)}`,
      `DESCRIPTION:${escapeText(alarm.description)}`,
      'END:VALARM',
    )
  }

  lines.push('END:VEVENT')
  return lines
}

/** A complete .ics document, CRLF-terminated as the spec requires. */
export function buildCalendar(events: readonly IcsEvent[], opts: IcsCalendarOptions): string {
  const now = opts.now ?? new Date()
  const refresh = Math.max(15, Math.trunc(opts.refreshMinutes ?? 60))
  const refreshDuration = refresh % 60 === 0 ? `PT${refresh / 60}H` : `PT${refresh}M`

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Cirqle//Social Posting//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(opts.name)}`,
    'X-WR-TIMEZONE:Asia/Kolkata',
    // Two spellings of the same instruction: Apple reads REFRESH-INTERVAL,
    // older Outlook and Google read X-PUBLISHED-TTL.
    `REFRESH-INTERVAL;VALUE=DURATION:${refreshDuration}`,
    `X-PUBLISHED-TTL:${refreshDuration}`,
  ]
  if (opts.description) lines.push(`X-WR-CALDESC:${escapeText(opts.description)}`)

  for (const ev of events) lines.push(...eventLines(ev, now))
  lines.push('END:VCALENDAR')

  return lines.map(foldLine).join('\r\n') + '\r\n'
}

// ── The posting event itself ─────────────────────────────────────────────────

export interface PostingEventInput {
  /** social_calendar_items.id — stable, so the event updates in place. */
  itemId: string
  clientName: string
  title: string
  /** The instant it goes out. */
  postAt: Date
  contentType?: string | null
  platforms?: string[] | null
  /** Absolute link into the posting queue. */
  url?: string
  /** Waiting on the client — said plainly rather than hidden. */
  awaitingApproval?: boolean
  cancelled?: boolean
  /** Drives SEQUENCE, so an edited post updates on the phone. */
  updatedAt?: Date | null
  reminderMinutes?: number
}

/**
 * One planned post as a calendar event.
 *
 * The summary is written to be readable on a lock screen with no app open:
 * client first, because the person posts for several, then what it is. The
 * description carries the rest — the body text people actually read when they
 * tap the alert while walking to their desk.
 */
export function postingEvent(input: PostingEventInput): IcsEvent {
  const platforms = (input.platforms ?? []).filter(Boolean)
  const where = platforms.length ? platforms.join(' + ') : null
  const summary = `Post: ${input.clientName} — ${input.title}`

  const detail = [
    input.contentType ? `Type: ${input.contentType}` : null,
    where ? `Where: ${where}` : null,
    input.awaitingApproval ? 'Waiting on client approval — check before posting.' : null,
    input.url ? `Open: ${input.url}` : null,
  ].filter(Boolean) as string[]

  const lead = input.reminderMinutes ?? 15
  return {
    uid: `social-post-${input.itemId}@cirqle.work`,
    start: input.postAt,
    end: new Date(input.postAt.getTime() + 15 * 60_000),
    summary,
    description: detail.join('\n'),
    url: input.url,
    // 1 is the highest RFC 5545 priority. The whole feature exists because
    // these get missed, so they are never a casual entry.
    priority: 1,
    status: input.cancelled ? 'CANCELLED' : input.awaitingApproval ? 'TENTATIVE' : 'CONFIRMED',
    categories: ['Cirqle', 'Social'],
    sequence: input.updatedAt ? Math.floor(input.updatedAt.getTime() / 1000) : 0,
    alarms: [
      { minutesBefore: lead, description: `${summary} — in ${lead} minutes` },
      { minutesBefore: 0, description: `${summary} — now` },
    ],
  }
}
