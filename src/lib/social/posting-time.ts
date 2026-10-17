/**
 * When a post actually goes out — pure domain helpers (no Supabase, unit-tested).
 *
 * ── The problem this exists for ─────────────────────────────────────────────
 *
 * The planner has only ever known the DAY a post belongs to:
 * `social_calendar_items.scheduled_date` is a DATE. But the time is the part
 * that is decided per client, from their own page analytics, and it is the
 * part that gets missed — a poster finished on time and published at 11pm is
 * a poster that missed its slot.
 *
 * ── Three sources, one of them authoritative ────────────────────────────────
 *
 * SLOTS are the plan: a client's weekly template ("Mon/Wed/Fri 19:30"),
 * typed in by the person who read the analytics. They decide what gets
 * scheduled.
 *
 * BEST TIMES are evidence: hourly engagement, whether pulled from Meta's
 * `online_followers` for a connected account or read off a screenshot of
 * someone's dashboard. They only ever SUGGEST — they never silently move a
 * post, because the person who set 19:30 may have had a reason the numbers
 * cannot see (the client's own shop hours, a sector norm, a standing request).
 *
 * ASAP is the escape hatch: a trending poster goes out now and has no slot at
 * all. Modelled as the absence of a time, not as a magic time value.
 *
 * ── Why wall-clock strings, not timestamps ──────────────────────────────────
 *
 * A slot is "19:30 on the India business calendar", not an instant. Storing it
 * as an instant would make a template drift the moment anything about the zone
 * changed. `postInstant()` is the single place a wall-clock plan becomes a real
 * UTC moment, and it derives the offset from BUSINESS_TIME_ZONE rather than
 * hard-coding +05:30.
 */
import { BUSINESS_TIME_ZONE } from '@/lib/utils/local-date'

/** How long before a post the person needs to be told. */
export const DEFAULT_REMINDER_MINUTES = 15

/** 0 = Sunday, matching JS getDay() and Postgres EXTRACT(DOW). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

export const WEEKDAY_LABEL: Record<Weekday, string> = {
  0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday',
  4: 'Thursday', 5: 'Friday', 6: 'Saturday',
}

export const WEEKDAY_SHORT: Record<Weekday, string> = {
  0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat',
}

/** Where a suggested time came from. Shown to the user — never hidden. */
export type TimeSource = 'slot' | 'meta' | 'screenshot' | 'manual'

export const TIME_SOURCE_LABEL: Record<TimeSource, string> = {
  slot:       'Your posting slot',
  meta:       'Instagram — when followers are online',
  screenshot: 'From an analytics screenshot',
  manual:     'Typed in',
}

/** A client's standing posting time. The plan, not a guess. */
export interface PostingSlot {
  id: string
  weekday: Weekday
  /** Wall clock on the business calendar, 'HH:MM'. */
  time: string
  /** Empty means "any platform this client posts to". */
  platforms: string[]
  label: string | null
  /** Lower sorts first. Which slot a batch fills before the next. */
  priority: number
  active: boolean
}

/** Evidence from analytics. Suggests; never decides. */
export interface BestTime {
  weekday: Weekday
  /** 0–23, business calendar. */
  hour: number
  /** Relative strength. Only ever compared against others from the same source. */
  score: number
  source: Exclude<TimeSource, 'slot'>
}

export interface TimeSuggestion {
  /** 'HH:MM' on the business calendar. */
  time: string
  source: TimeSource
  /** Why this is being offered, in the user's words. */
  reason: string
  /** A slot already used by another post on this date is offered last, not hidden. */
  taken: boolean
  slotId?: string
}

// ── Wall-clock helpers ───────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * Coerce anything a form or Postgres hands us into 'HH:MM', or null.
 *
 * Postgres TIME comes back as '19:30:00'; a person types '7:30' or '19:30 '.
 * Rejecting the loose ones would mean a saved slot that silently never matches,
 * which is the failure this whole module exists to prevent.
 */
export function normalizeTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?(?:\.\d+)?\s*$/.exec(value)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return `${pad2(h)}:${pad2(min)}`
}

/** Minutes past midnight, for ordering. -1 for an unparseable time. */
export function timeToMinutes(time: string | null | undefined): number {
  const t = normalizeTime(time)
  if (!t) return -1
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
}

/** '19:30' → '7:30 pm'. The only form anyone in the office reads. */
export function formatTime12(time: string | null | undefined): string {
  const t = normalizeTime(time)
  if (!t) return ''
  const h = Number(t.slice(0, 2))
  const m = t.slice(3, 5)
  const suffix = h < 12 ? 'am' : 'pm'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${m} ${suffix}`
}

/**
 * The weekday of a 'YYYY-MM-DD', with no timezone in play.
 *
 * Date.UTC rather than new Date(iso): the latter parses a bare date as UTC
 * midnight and then getDay() reports it in the machine's zone, which is the
 * previous day for anyone west of Greenwich.
 */
export function weekdayOf(isoDate: string): Weekday {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!m) throw new Error(`weekdayOf: expected YYYY-MM-DD, got ${isoDate}`)
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCDay() as Weekday
}

const offsetFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
})

/** How far BUSINESS_TIME_ZONE is from UTC at a given instant, in ms. */
function zoneOffsetMs(at: Date): number {
  const parts = offsetFormatter.formatToParts(at)
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - at.getTime()
}

/**
 * The real instant a 'YYYY-MM-DD' + 'HH:MM' plan happens.
 *
 * Two passes. The first treats the wall clock as UTC to find roughly which
 * instant we are near, then subtracts that instant's offset; the second
 * re-measures at the corrected instant. India has no DST so one pass is already
 * exact — the second costs nothing and keeps this honest if the business ever
 * books from a zone that does.
 */
export function postInstant(isoDate: string, time: string): Date | null {
  const t = normalizeTime(time)
  if (!t) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!m) return null
  const wall = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(t.slice(0, 2)), Number(t.slice(3, 5)),
  )
  let instant = new Date(wall - zoneOffsetMs(new Date(wall)))
  instant = new Date(wall - zoneOffsetMs(instant))
  return instant
}

/** When to warn, given when it posts. Null in, null out. */
export function remindAt(
  postAt: Date | null,
  leadMinutes: number = DEFAULT_REMINDER_MINUTES,
): Date | null {
  if (!postAt) return null
  const lead = Number.isFinite(leadMinutes) ? Math.max(0, Math.trunc(leadMinutes)) : DEFAULT_REMINDER_MINUTES
  return new Date(postAt.getTime() - lead * 60_000)
}

// ── Slots ────────────────────────────────────────────────────────────────────

/** Active slots that apply on a date, in the order a batch should fill them. */
export function slotsOn(slots: readonly PostingSlot[], isoDate: string): PostingSlot[] {
  const wd = weekdayOf(isoDate)
  return slots
    .filter(s => s.active && s.weekday === wd && normalizeTime(s.time) !== null)
    .sort((a, b) => a.priority - b.priority || timeToMinutes(a.time) - timeToMinutes(b.time))
}

/**
 * What to offer for a date, best first.
 *
 * Order is deliberate and is the whole policy of this module: the client's own
 * slots come before anything analytics suggests, and a slot another post has
 * already taken is pushed to the end rather than dropped — two posts in one
 * evening is a decision the planner is allowed to make, it just should not be
 * the default.
 */
export function suggestTimes(
  isoDate: string,
  opts: {
    slots?: readonly PostingSlot[]
    bestTimes?: readonly BestTime[]
    /** 'HH:MM' values already used on this date. */
    taken?: readonly string[]
    limit?: number
  } = {},
): TimeSuggestion[] {
  const wd = weekdayOf(isoDate)
  const takenSet = new Set(
    (opts.taken ?? []).map(t => normalizeTime(t)).filter((t): t is string => t !== null),
  )

  const out: TimeSuggestion[] = []
  const seen = new Set<string>()

  for (const slot of slotsOn(opts.slots ?? [], isoDate)) {
    const time = normalizeTime(slot.time)!
    if (seen.has(time)) continue
    seen.add(time)
    out.push({
      time,
      source: 'slot',
      reason: slot.label?.trim()
        ? `${slot.label.trim()} — ${WEEKDAY_SHORT[wd]} ${formatTime12(time)}`
        : `Your ${WEEKDAY_SHORT[wd]} slot`,
      taken: takenSet.has(time),
      slotId: slot.id,
    })
  }

  const evidence = (opts.bestTimes ?? [])
    .filter(b => b.weekday === wd && Number.isInteger(b.hour) && b.hour >= 0 && b.hour <= 23)
    .sort((a, b) => b.score - a.score)
  for (const b of evidence) {
    const time = `${pad2(b.hour)}:00`
    if (seen.has(time)) continue
    seen.add(time)
    out.push({
      time,
      source: b.source,
      reason: b.source === 'meta'
        ? `Most followers online ${WEEKDAY_SHORT[wd]} around ${formatTime12(time)}`
        : `Analytics screenshot — ${WEEKDAY_SHORT[wd]} around ${formatTime12(time)}`,
      taken: takenSet.has(time),
    })
  }

  // Free slots first, then analytics, then anything already taken — but never
  // reordering within those groups, so the client's priority survives.
  const rank = (s: TimeSuggestion) => (s.taken ? 2 : s.source === 'slot' ? 0 : 1)
  const ranked = out
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
    .map(x => x.s)

  return typeof opts.limit === 'number' ? ranked.slice(0, Math.max(0, opts.limit)) : ranked
}

/** The single best time to pre-fill a new plan row with, or null to leave blank. */
export function defaultTimeFor(
  isoDate: string,
  opts: { slots?: readonly PostingSlot[]; bestTimes?: readonly BestTime[]; taken?: readonly string[] } = {},
): string | null {
  const first = suggestTimes(isoDate, { ...opts, limit: 1 })[0]
  return first && !first.taken ? first.time : null
}

// ── Bulk planning ────────────────────────────────────────────────────────────

/** A poster waiting for a time. */
export interface PlannableItem {
  id: string
  /** The day it is currently planned for, 'YYYY-MM-DD'. */
  isoDate: string
  /** Lower goes out first within a day. */
  priority?: number
  /** Ordering within a day when priorities tie. */
  displayOrder?: number
  /** Already has a time — left alone unless `overwrite`. */
  time?: string | null
  /** Trending: goes out now, never takes a slot. */
  asap?: boolean
}

export interface Assignment {
  itemId: string
  isoDate: string
  time: string
  slotId?: string
  source: TimeSource
}

export interface AssignResult {
  assignments: Assignment[]
  /** Items with no slot free on their day — shown, never silently dropped. */
  unplaced: Array<{ itemId: string; isoDate: string; reason: string }>
  /** Items deliberately skipped: already timed, or ASAP. */
  skipped: Array<{ itemId: string; reason: string }>
}

/**
 * Give a batch of posters their times.
 *
 * Fills each day's slots in the client's own priority order, highest-priority
 * poster first. It does NOT spill into another day: a poster planned for the
 * 4th with no free slot on the 4th comes back as unplaced, with a reason. The
 * alternative — quietly moving it to the 5th — is how a post ends up published
 * on the wrong day, which is the same class of bug as missing the time.
 */
export function assignTimes(
  items: readonly PlannableItem[],
  slots: readonly PostingSlot[],
  opts: { bestTimes?: readonly BestTime[]; overwrite?: boolean; allowDoubleUp?: boolean } = {},
): AssignResult {
  const assignments: Assignment[] = []
  const unplaced: AssignResult['unplaced'] = []
  const skipped: AssignResult['skipped'] = []

  const byDate = new Map<string, PlannableItem[]>()
  for (const item of items) {
    if (item.asap) { skipped.push({ itemId: item.id, reason: 'Posting as soon as it is ready' }); continue }
    if (!opts.overwrite && normalizeTime(item.time) !== null) {
      skipped.push({ itemId: item.id, reason: `Already set for ${formatTime12(item.time)}` })
      continue
    }
    byDate.set(item.isoDate, [...(byDate.get(item.isoDate) ?? []), item])
  }

  for (const [isoDate, dayItems] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const ordered = [...dayItems].sort(
      (a, b) => (a.priority ?? 0) - (b.priority ?? 0)
        || (a.displayOrder ?? 0) - (b.displayOrder ?? 0)
        || a.id.localeCompare(b.id),
    )

    // Times already spoken for on this day by posts we are NOT re-timing.
    const used = new Set<string>(
      items
        .filter(i => i.isoDate === isoDate && !ordered.some(o => o.id === i.id))
        .map(i => normalizeTime(i.time))
        .filter((t): t is string => t !== null),
    )

    const daySlots = slotsOn(slots, isoDate)
    for (const item of ordered) {
      const free = daySlots.find(s => {
        const t = normalizeTime(s.time)!
        return opts.allowDoubleUp || !used.has(t)
      })
      if (free) {
        const time = normalizeTime(free.time)!
        used.add(time)
        assignments.push({ itemId: item.id, isoDate, time, slotId: free.id, source: 'slot' })
        if (!opts.allowDoubleUp) daySlots.splice(daySlots.indexOf(free), 1)
        continue
      }

      const fallback = suggestTimes(isoDate, { bestTimes: opts.bestTimes, taken: [...used] })
        .find(s => !s.taken && s.source !== 'slot')
      if (fallback) {
        used.add(fallback.time)
        assignments.push({ itemId: item.id, isoDate, time: fallback.time, source: fallback.source })
        continue
      }

      unplaced.push({
        itemId: item.id,
        isoDate,
        reason: daySlots.length === 0 && slotsOn(slots, isoDate).length === 0
          ? `No posting slot set for ${WEEKDAY_LABEL[weekdayOf(isoDate)]}`
          : 'Every slot that day is already taken',
      })
    }
  }

  return { assignments, unplaced, skipped }
}

// ── Reading the clock ────────────────────────────────────────────────────────

export type PostTiming = 'asap' | 'overdue' | 'due_now' | 'today' | 'upcoming' | 'untimed'

/**
 * How a planned post stands against the clock right now.
 *
 * `due_now` opens at the reminder lead and stays open for a grace period after
 * the slot, because the whole point is to catch someone BEFORE the moment and
 * keep nagging until they confirm — a post that flips straight to 'overdue' at
 * 19:31 tells them only that they have already failed.
 */
export function postTiming(
  opts: { isoDate: string; time: string | null; asap?: boolean; posted?: boolean },
  now: Date = new Date(),
  leadMinutes: number = DEFAULT_REMINDER_MINUTES,
  graceMinutes = 45,
): PostTiming {
  if (opts.posted) return 'upcoming'
  if (opts.asap) return 'asap'
  const time = normalizeTime(opts.time)
  if (!time) return 'untimed'
  const at = postInstant(opts.isoDate, time)
  if (!at) return 'untimed'

  const diffMin = (at.getTime() - now.getTime()) / 60_000
  if (diffMin <= -graceMinutes) return 'overdue'
  if (diffMin <= leadMinutes) return 'due_now'

  // Same business day, but further out than the reminder window.
  const nowDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
  return nowDay === opts.isoDate ? 'today' : 'upcoming'
}

export const TIMING_LABEL: Record<PostTiming, string> = {
  asap:     'Post now',
  overdue:  'Missed its time',
  due_now:  'Post now',
  today:    'Later today',
  upcoming: 'Upcoming',
  untimed:  'No time set',
}
