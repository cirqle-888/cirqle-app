/**
 * Server-side date bounding for report pages.
 *
 * The report pages used to fetch EVERY task and EVERY contribution score on
 * every view and filter them client-side — ~4–5 MB of egress per page view,
 * which is what was burning the Supabase free-tier egress quota. The date
 * filter already lives in the URL (`?date={"type":"lastMonth"}`) and
 * `router.replace` re-runs the server component, so the server can apply the
 * SAME filter to the query and ship only the window being looked at.
 *
 * Contract with the client:
 *   • URL has a date filter        → fetch exactly that window (+ the client
 *     still applies matchesDateFilter on top, so display logic is unchanged).
 *   • URL has `date=all`           → fetch everything (explicit user choice).
 *   • URL has NO date param        → fetch the DEFAULT WINDOW (last 12
 *     months). The page tells the user, and picking "All time" in the filter
 *     writes `date=all` rather than clearing the param — absence means
 *     "default", never "everything", or the landing view would keep paying
 *     for all history nobody asked to see.
 *
 * Pure date arithmetic — no I/O — mirroring matchesDateFilter's semantics in
 * src/components/ui/date-filter.tsx for every preset it defines.
 */

import type { DateFilterValue } from '@/components/ui/date-filter'
import { toISODate, todayISO, monthStartISO, monthEndISO, lastDayOfMonthISO, daysFromTodayISO } from '@/lib/utils/local-date'

export interface DateWindow {
  /** Inclusive YYYY-MM-DD, or null for unbounded. */
  from: string | null
  to: string | null
  /** Human label for the "showing…" note; null when unbounded. */
  label: string | null
}

// Windows are bounded on the India business calendar, not on whatever clock the
// process runs at. Vercel runs Node at UTC, so reading `now`'s LOCAL fields
// here put "today" 5.5 hours behind the office — a report opened before 05:30
// IST covered the wrong day, and "this month" opened on the 1st only after
// lunch. `filter.year`/`filter.month`/`filter.from` are user-supplied and
// already absolute, so they stay untouched.
const iso = toISODate

export const UNBOUNDED: DateWindow = { from: null, to: null, label: null }

/** Parse the `?date=` search param. 'all' is the explicit everything sentinel. */
export function parseDateParam(raw: string | string[] | undefined): DateFilterValue | 'all' | null {
  const s = Array.isArray(raw) ? raw[0] : raw
  if (!s) return null
  if (s === 'all') return 'all'
  try {
    const v = JSON.parse(s) as DateFilterValue
    return v && typeof v === 'object' && 'type' in v ? v : null
  } catch {
    return null
  }
}

/** The [from, to] window a DateFilterValue covers (both inclusive). */
export function windowForFilter(filter: DateFilterValue, now = new Date()): DateWindow {
  const day = (delta: number) => daysFromTodayISO(delta, now)

  switch (filter?.type) {
    case 'today':     return { from: day(0), to: day(0), label: 'today' }
    case 'yesterday': return { from: day(-1), to: day(-1), label: 'yesterday' }
    case 'last7':     return { from: day(-6), to: day(0), label: 'the last 7 days' }
    case 'last30':    return { from: day(-29), to: day(0), label: 'the last 30 days' }
    case 'thisMonth':
      return { from: monthStartISO(0, now), to: monthEndISO(0, now), label: 'this month' }
    case 'lastMonth':
      return { from: monthStartISO(-1, now), to: monthEndISO(-1, now), label: 'last month' }
    case 'month': {
      // filter.month is 0-indexed; lastDayOfMonthISO takes it 1-indexed.
      const from = `${filter.year}-${String(filter.month + 1).padStart(2, '0')}-01`
      return { from, to: lastDayOfMonthISO(filter.year, filter.month + 1), label: from.slice(0, 7) }
    }
    case 'range': return { from: filter.from, to: filter.to, label: `${filter.from} → ${filter.to}` }
    case 'day':   return { from: filter.date, to: filter.date, label: filter.date }
    default:      return UNBOUNDED
  }
}

/** The default window when the URL names none: last 12 months. */
export function defaultWindow(now = new Date()): DateWindow {
  const to = todayISO(now)
  const [y, m, d] = to.split('-')
  return { from: `${Number(y) - 1}-${m}-${d}`, to, label: 'the last 12 months' }
}

/** One-call resolution of the `?date=` param into a fetch window. */
export function resolveFetchWindow(
  raw: string | string[] | undefined,
  now = new Date(),
): DateWindow {
  const parsed = parseDateParam(raw)
  if (parsed === 'all') return UNBOUNDED
  if (parsed === null) return defaultWindow(now)
  return windowForFilter(parsed, now)
}

/**
 * Widen a task-date window for `contribution_scores.calculated_at` bounding.
 * Scores are written when work is SCORED, which can trail the task date by
 * weeks — so only the lower bound is applied, pulled back by `slackDays`, and
 * the upper bound is dropped. Over-fetching a few newer scores is harmless
 * (the report matches by task id); dropping a late-scored task's earnings is
 * not.
 */
export function scoreWindowFor(taskWindow: DateWindow, slackDays = 45): { fromTs: string | null } {
  if (!taskWindow.from) return { fromTs: null }
  const d = new Date(taskWindow.from + 'T00:00:00')
  d.setDate(d.getDate() - slackDays)
  return { fromTs: `${iso(d)}T00:00:00Z` }
}
