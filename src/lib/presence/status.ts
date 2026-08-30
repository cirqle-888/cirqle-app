/**
 * Presence & status — the rule, in one place.
 *
 * What people see next to a colleague's avatar is TWO things resolved into
 * one: an automatic signal (are their tabs alive?) and a manual pick (what did
 * they say they're doing?). Every surface — header, chat sidebar, member list,
 * profile — calls `derivePresence` so they can never disagree with each other.
 *
 * Modelled on how Teams / Slack / Google Chat behave, because that is what
 * people already expect a green dot to mean:
 *
 *   • A manual pick only holds while the person is actually around. Set
 *     "Busy" and shut the laptop and you go Away, then Offline — otherwise the
 *     board is full of people who look busy and left hours ago.
 *   • "Appear offline" is the one exception: it wins over everything, always.
 *     A privacy control that leaks the moment you type is not a privacy
 *     control.
 *   • The note ("🌴 On leave") outlives the dot. It stays readable while
 *     they're offline, until it expires, because that is when it's most useful.
 *
 * Pure and dependency-free on purpose — status.test.ts pins the whole rule.
 */

import { daysFromTodayISO } from '@/lib/utils/local-date'

// ── Vocabulary ───────────────────────────────────────────────────────────────

export type PresenceStatus =
  | 'available'   // around and free
  | 'busy'        // around, in something
  | 'dnd'         // around, do not interrupt
  | 'brb'         // stepped away briefly, by choice
  | 'away'        // idle, or chose to look idle
  | 'offline'     // gone, or chose to look gone

/** The subset a person may pick for themselves. `null` = follow my activity. */
export type ManualStatus = PresenceStatus

export interface PresenceMeta {
  label: string
  /** Sentence shown under the label in the picker. */
  hint: string
  /** Tailwind classes for the dot's fill. Empty for the hollow states. */
  dot: string
  /** Tailwind classes for the dot's border — carries the hollow states. */
  ring: string
  /** A white bar across the dot (dnd) or a notch (brb), Teams-style. */
  glyph: 'none' | 'bar' | 'notch'
  /** Text colour for the label when rendered as a chip. */
  text: string
}

export const STATUS_META: Record<PresenceStatus, PresenceMeta> = {
  available: {
    label: 'Available', hint: 'Around and free to talk',
    dot: 'bg-emerald-500', ring: 'border-emerald-500', glyph: 'none',
    text: 'text-emerald-600 dark:text-emerald-400',
  },
  busy: {
    label: 'Busy', hint: 'Around, but heads-down',
    dot: 'bg-red-500', ring: 'border-red-500', glyph: 'none',
    text: 'text-red-600 dark:text-red-400',
  },
  dnd: {
    label: 'Do not disturb', hint: 'Notifications muted — only urgent pings',
    dot: 'bg-red-600', ring: 'border-red-600', glyph: 'bar',
    text: 'text-red-600 dark:text-red-400',
  },
  brb: {
    label: 'Be right back', hint: 'Stepped out for a moment',
    dot: 'bg-amber-400', ring: 'border-amber-400', glyph: 'notch',
    text: 'text-amber-600 dark:text-amber-400',
  },
  away: {
    label: 'Away', hint: 'Idle, or not at the desk',
    dot: 'bg-transparent', ring: 'border-amber-400', glyph: 'none',
    text: 'text-amber-600 dark:text-amber-400',
  },
  offline: {
    label: 'Offline', hint: 'Not signed in anywhere',
    dot: 'bg-transparent', ring: 'border-muted-foreground/60', glyph: 'none',
    text: 'text-muted-foreground',
  },
}

/** Order shown in the picker. `away` and `offline` read as "Appear …" there —
 *  choosing them is a deliberate act, unlike the automatic versions. */
export const MANUAL_CHOICES: { status: ManualStatus; label: string }[] = [
  { status: 'available', label: 'Available' },
  { status: 'busy',      label: 'Busy' },
  { status: 'dnd',       label: 'Do not disturb' },
  { status: 'brb',       label: 'Be right back' },
  { status: 'away',      label: 'Appear away' },
  { status: 'offline',   label: 'Appear offline' },
]

/** Statuses that mean "do not ping me" — the chat surfaces dim on these. */
export function isMuted(status: PresenceStatus): boolean {
  return status === 'dnd'
}

// ── Freshness windows ────────────────────────────────────────────────────────
// The heartbeat fires every 60s from visible tabs, so ONLINE has to tolerate a
// missed beat plus clock skew, and AWAY has to be long enough that reading a
// long document doesn't turn you yellow. Both are in one place so a change to
// the heartbeat interval has exactly one other number to move.

export const HEARTBEAT_MS = 60_000
export const ONLINE_WINDOW_MS = 3 * 60_000     // seen within 3 min → around
export const AWAY_WINDOW_MS = 15 * 60_000      // within 15 min → away, past → offline

// ── The stored row ───────────────────────────────────────────────────────────

export interface PresenceRow {
  employee_id: string
  manual_status: ManualStatus | null
  status_emoji: string | null
  status_text: string | null
  status_expires_at: string | null
  last_seen_at: string | null
  device: string | null
}

export interface EffectivePresence {
  employeeId: string
  status: PresenceStatus
  /** True when the dot came from the heartbeat rather than a manual pick. */
  isAuto: boolean
  /** The manual pick, even when staleness overrode the dot — the picker needs
   *  to show what you actually chose, not what everyone else currently sees. */
  manual: ManualStatus | null
  emoji: string | null
  note: string | null
  lastSeenAt: string | null
  device: string | null
}

const UNKNOWN = (employeeId: string): EffectivePresence => ({
  employeeId, status: 'offline', isAuto: true, manual: null,
  emoji: null, note: null, lastSeenAt: null, device: null,
})

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * Resolve a stored row into what a viewer should see, at instant `now`.
 *
 * A missing row is Offline rather than an error state: an employee who has
 * never opened the app since this shipped has no row, and "offline" is the
 * honest answer for them.
 */
export function derivePresence(
  row: PresenceRow | null | undefined,
  now: Date | number = new Date(),
  employeeId?: string,
): EffectivePresence {
  const nowMs = typeof now === 'number' ? now : now.getTime()
  if (!row) return UNKNOWN(employeeId ?? '')

  const expiresAt = ms(row.status_expires_at)
  const expired = expiresAt !== null && expiresAt <= nowMs

  // An expired pick is as if it was never made — both the dot and the note go.
  const manual = expired ? null : row.manual_status ?? null
  const emoji = expired ? null : row.status_emoji ?? null
  const note = expired ? null : row.status_text ?? null

  const seen = ms(row.last_seen_at)
  const age = seen === null ? Infinity : Math.max(0, nowMs - seen)

  const base: Omit<EffectivePresence, 'status' | 'isAuto'> = {
    employeeId: row.employee_id || employeeId || '',
    manual, emoji, note,
    lastSeenAt: row.last_seen_at ?? null,
    device: row.device ?? null,
  }

  // Invisible mode outranks the heartbeat — that is the whole point of it.
  if (manual === 'offline') return { ...base, status: 'offline', isAuto: false }

  const auto: PresenceStatus =
    age <= ONLINE_WINDOW_MS ? 'available'
    : age <= AWAY_WINDOW_MS ? 'away'
    : 'offline'

  // A pick only speaks for someone while they're actually here.
  if (manual && auto === 'available') return { ...base, status: manual, isAuto: false }

  return { ...base, status: auto, isAuto: true }
}

/** True when this person can be reached right now (any "around" state). */
export function isOnline(status: PresenceStatus): boolean {
  return status === 'available' || status === 'busy' || status === 'dnd' || status === 'brb'
}

// ── "Clear after" ────────────────────────────────────────────────────────────

export type ClearAfterId = 'never' | '30m' | '1h' | '4h' | 'today' | 'week'

export const CLEAR_AFTER_OPTIONS: { id: ClearAfterId; label: string }[] = [
  { id: 'never', label: "Don't clear" },
  { id: '30m',   label: '30 minutes' },
  { id: '1h',    label: '1 hour' },
  { id: '4h',    label: '4 hours' },
  { id: 'today', label: 'Today' },
  { id: 'week',  label: 'This week' },
]

/** Midnight (India business calendar) `delta` days from today, as an instant. */
function istMidnightISO(delta: number, now: Date): string {
  return new Date(`${daysFromTodayISO(delta, now)}T00:00:00+05:30`).toISOString()
}

/**
 * The instant a pick should stop applying, or null for "don't clear".
 *
 * "Today" and "This week" resolve on the India business calendar, like every
 * other date in the app — a status set at 11pm should expire in an hour, not
 * have already expired because the server thinks it is tomorrow in UTC.
 */
export function resolveClearAfter(id: ClearAfterId, now: Date = new Date()): string | null {
  switch (id) {
    case 'never': return null
    case '30m':   return new Date(now.getTime() + 30 * 60_000).toISOString()
    case '1h':    return new Date(now.getTime() + 60 * 60_000).toISOString()
    case '4h':    return new Date(now.getTime() + 4 * 60 * 60_000).toISOString()
    // Tomorrow 00:00 IST — i.e. the end of today.
    case 'today': return istMidnightISO(1, now)
    // Next Monday 00:00 IST. Monday → 7 days out; Sunday → tomorrow.
    case 'week':
      return istMidnightISO(8 - istWeekday(now), now)
  }
}

/** 1 = Monday … 7 = Sunday, on the India business calendar. */
function istWeekday(now: Date): number {
  const short = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', weekday: 'short',
  }).format(now)
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
  return map[short] ?? 1
}

// ── Rendering helpers ────────────────────────────────────────────────────────

/**
 * "Active now" / "Away · 12m" / "Last seen 3h ago" — the line under a name.
 * Returns null when there is nothing honest to say (no row at all).
 */
export function lastSeenLabel(
  p: EffectivePresence,
  now: Date | number = new Date(),
): string | null {
  if (isOnline(p.status)) return p.isAuto ? 'Active now' : STATUS_META[p.status].label
  if (!p.lastSeenAt) return null
  // Invisible mode must not leak a timestamp — that would defeat it.
  if (p.manual === 'offline') return null

  const nowMs = typeof now === 'number' ? now : now.getTime()
  const seen = ms(p.lastSeenAt)
  if (seen === null) return null
  const mins = Math.max(0, Math.round((nowMs - seen) / 60_000))

  if (mins < 1) return 'Active now'
  if (mins < 60) return `Last seen ${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `Last seen ${hrs}h ago`
  const days = Math.round(hrs / 24)
  return days === 1 ? 'Last seen yesterday' : `Last seen ${days}d ago`
}

/** One-line summary for a tooltip: status, plus the note when there is one. */
export function presenceTitle(p: EffectivePresence, now: Date | number = new Date()): string {
  const label = STATUS_META[p.status].label
  const note = [p.emoji, p.note].filter(Boolean).join(' ').trim()
  const seen = lastSeenLabel(p, now)
  const tail = seen && seen !== label ? ` · ${seen}` : ''
  return note ? `${label} — ${note}${tail}` : `${label}${tail}`
}
