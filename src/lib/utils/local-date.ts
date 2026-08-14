/**
 * Calendar-date helpers for values that get STORED or QUERIED.
 *
 * The counterpart to format-date.ts, which is for rendering only. Everything
 * here produces `YYYY-MM-DD` — the shape task_date, entry_date, issue_date and
 * every other date column expect.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * `new Date().toISOString().split('T')[0]` reads like "today" and is not. It
 * converts to UTC first, so anywhere east of Greenwich it can name yesterday.
 * In IST (UTC+5:30) that breaks two ways:
 *
 *   1. Any date built from local parts is shifted a full day, always:
 *        new Date(2026, 7, 1).toISOString().split('T')[0]  →  '2026-07-31'
 *      A "start of this month" filter silently begins on the last day of the
 *      previous month, every day of the year.
 *
 *   2. "Today" is wrong from midnight to 05:30 local:
 *        01:00 IST on 15 Aug  →  '2026-08-14'
 *      An entry saved after midnight is filed to the previous day — and on the
 *      1st of a month, to the previous MONTH, which is what payroll and the
 *      month-close reports read.
 *
 * The fix is to read the local calendar fields the user is actually looking at
 * rather than round-tripping through UTC. No timezone is assumed or
 * configured: whatever clock the browser (or server) is on, these agree with
 * it.
 *
 * These are for wall-clock dates. Timestamps keep using toISOString() — an
 * instant genuinely is UTC.
 */

/**
 * A Date's local calendar day as `YYYY-MM-DD`.
 *
 * Use this instead of `.toISOString().split('T')[0]` for any Date built from
 * local parts (`new Date(y, m, d)`) or from `new Date()`.
 */
export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Today, on the local calendar. The default for any "date" field. */
export function todayISO(now: Date = new Date()): string {
  return toISODate(now)
}

/** The first day of the month `offset` months from now (0 = this month). */
export function monthStartISO(offset = 0, now: Date = new Date()): string {
  return toISODate(new Date(now.getFullYear(), now.getMonth() + offset, 1))
}

/** The last day of the month `offset` months from now (0 = this month). */
export function monthEndISO(offset = 0, now: Date = new Date()): string {
  return toISODate(new Date(now.getFullYear(), now.getMonth() + offset + 1, 0))
}

/** The last day of a specific 1-indexed month, e.g. lastDayOfMonthISO(2026, 8). */
export function lastDayOfMonthISO(year: number, month1Indexed: number): string {
  return toISODate(new Date(year, month1Indexed, 0))
}

/** `delta` days from now (negative for the past), on the local calendar. */
export function daysFromTodayISO(delta: number, now: Date = new Date()): string {
  // Noon anchor: stepping by whole days from midnight can land on 23:00 the
  // day before across a DST boundary.
  const d = new Date(now)
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() + delta)
  return toISODate(d)
}
