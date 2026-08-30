/**
 * Calendar-date helpers for values that get STORED or QUERIED.
 *
 * The counterpart to format-date.ts, which is for rendering only. Everything
 * here produces `YYYY-MM-DD` — the shape task_date, entry_date, issue_date and
 * every other date column expect.
 *
 * ── The business calendar is India ──────────────────────────────────────────
 *
 * Cirqle's books close on the India calendar, so "today", "this month" and
 * every stored calendar date resolve in **Asia/Kolkata (UTC+5:30)** — stated
 * explicitly here rather than inherited from whatever clock the machine
 * happens to be on. That matters because the machine is never the right
 * answer:
 *
 *   - Vercel runs Node at UTC, and TZ is a RESERVED environment variable
 *     there, so the server clock cannot be moved to IST at all.
 *   - A browser follows the person, so a laptop that travels would silently
 *     start filing work to a different day than the office does.
 *
 * Deriving the date from an explicit zone removes both problems: server,
 * browser, CI and a developer's machine all agree, and the tests prove it by
 * running under three different process timezones.
 *
 * ── What was wrong before ───────────────────────────────────────────────────
 *
 * `new Date().toISOString().split('T')[0]` reads like "today" and is not. It
 * converts to UTC first, which against an IST calendar breaks two ways:
 *
 *   1. A date built from local parts is shifted a full day, always:
 *        new Date(2026, 7, 1).toISOString().split('T')[0]  →  '2026-07-31'
 *      A "start of this month" filter silently begins on the last day of the
 *      previous month, every day of the year.
 *
 *   2. "Today" is wrong from midnight to 05:30 IST:
 *        01:00 IST on 15 Aug  →  '2026-08-14'
 *      Work saved after midnight is filed to the previous day — and on the
 *      1st, to the previous MONTH, which is what payroll and the month-close
 *      reports read.
 *
 * These are for wall-clock CALENDAR dates. True timestamps (created_at,
 * calculated_at) keep using toISOString() — an instant genuinely is UTC, and
 * localising one would be the opposite mistake.
 */

/** Cirqle's business timezone. Every calendar date below resolves here. */
export const BUSINESS_TIME_ZONE = 'Asia/Kolkata'

const pad2 = (n: number) => String(n).padStart(2, '0')

// Built once, not per call — constructing an Intl.DateTimeFormat is among the
// more expensive things in the Intl API, and these run inside list renders.
const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** The year/month/day an instant falls on, on the India business calendar. */
function businessParts(d: Date): { year: number; month: number; day: number } {
  // formatToParts rather than parsing a formatted string: no locale can
  // reorder or re-punctuate named parts, so this holds across ICU versions.
  const parts = partsFormatter.formatToParts(d)
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value)
  return { year: get('year'), month: get('month'), day: get('day') }
}

/**
 * The India-calendar day an instant falls on, as `YYYY-MM-DD`.
 *
 * Use this instead of `.toISOString().split('T')[0]` for any calendar date.
 */
export function toISODate(d: Date): string {
  const { year, month, day } = businessParts(d)
  return `${year}-${pad2(month)}-${pad2(day)}`
}

/** Today, on the India business calendar. The default for any date field. */
export function todayISO(now: Date = new Date()): string {
  return toISODate(now)
}

/** The first day of the month `offset` months from now (0 = this month). */
export function monthStartISO(offset = 0, now: Date = new Date()): string {
  const { year, month } = businessParts(now)
  // Whole-number month arithmetic — no Date involved, so nothing can drift.
  const total = year * 12 + (month - 1) + offset
  return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}-01`
}

/** The last day of the month `offset` months from now (0 = this month). */
export function monthEndISO(offset = 0, now: Date = new Date()): string {
  const { year, month } = businessParts(now)
  const total = year * 12 + (month - 1) + offset
  return lastDayOfMonthISO(Math.floor(total / 12), (total % 12) + 1)
}

/** The last day of a specific 1-indexed month, e.g. lastDayOfMonthISO(2026, 8). */
export function lastDayOfMonthISO(year: number, month1Indexed: number): string {
  // Day 0 of the following month is the last day of this one. Built in UTC so
  // the host timezone cannot shift it.
  const day = new Date(Date.UTC(year, month1Indexed, 0)).getUTCDate()
  return `${year}-${pad2(month1Indexed)}-${pad2(day)}`
}

/** `delta` days from today (negative for the past), on the business calendar. */
export function daysFromTodayISO(delta: number, now: Date = new Date()): string {
  const { year, month, day } = businessParts(now)
  // Step the calendar day in UTC, anchored at noon so no DST transition
  // anywhere can round the arithmetic onto a neighbouring day.
  const anchor = new Date(Date.UTC(year, month - 1, day, 12))
  anchor.setUTCDate(anchor.getUTCDate() + delta)
  return `${anchor.getUTCFullYear()}-${pad2(anchor.getUTCMonth() + 1)}-${pad2(anchor.getUTCDate())}`
}

/**
 * `delta` days from a `YYYY-MM-DD` date, staying on the calendar.
 *
 * The counterpart to {@link daysFromTodayISO} for a date you already hold —
 * a net-30 due date off an invoice's issue date, a quotation's validity
 * window. Terms are counted from the date on the document, so a back-dated
 * invoice gets a correct (possibly already overdue) due date instead of one
 * 30 days from whenever someone happened to press the button.
 *
 * Pure string-in/string-out, so no instant and no timezone are involved at
 * all: the input is already a calendar date, and re-deriving one through
 * `new Date(...).toISOString()` is what shifts it a day.
 *
 * Returns '' for a malformed input rather than 'NaN-NaN-NaN' — callers store
 * this straight into a date column, and an empty string is rejected loudly
 * while a NaN string silently becomes NULL.
 */
export function addDaysISO(iso: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso || '').trim())
  if (!m) return ''
  const [, y, mo, d] = m
  // Noon-anchored UTC for the same DST reason as daysFromTodayISO.
  const anchor = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), 12))
  if (Number.isNaN(anchor.getTime())) return ''
  anchor.setUTCDate(anchor.getUTCDate() + delta)
  return `${anchor.getUTCFullYear()}-${pad2(anchor.getUTCMonth() + 1)}-${pad2(anchor.getUTCDate())}`
}

/** Month abbreviations, so formatting never depends on a runtime locale. */
const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/**
 * A `YYYY-MM-DD` date as `30 Aug 26`, for display in a table cell.
 *
 * Pure string-in/string-out, like {@link addDaysISO} and for the same reason:
 * `new Date('2026-08-30')` parses as UTC midnight, so anywhere west of
 * Greenwich it formats as the 29th. A cash-book row that shows the wrong day
 * to a colleague travelling is a support ticket nobody enjoys.
 *
 * The month names are a literal table rather than toLocaleDateString, so the
 * output cannot drift with the viewer's locale — this is a ledger, and the
 * column has to read the same for everyone looking at it.
 *
 * The short year keeps the cell to one line at the narrow widths this column
 * gets, which is the whole point: `2026-08-30` wraps at its hyphens.
 *
 * Returns '' for anything malformed, so a bad value renders as an empty cell
 * rather than 'NaN NaN NaN'.
 */
export function formatISODateShort(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso || '').trim())
  if (!m) return ''
  const [, y, mo, d] = m
  const monthIndex = Number(mo) - 1
  if (monthIndex < 0 || monthIndex > 11) return ''
  const day = Number(d)
  if (day < 1 || day > 31) return ''
  return `${day} ${SHORT_MONTHS[monthIndex]} ${y.slice(2)}`
}
