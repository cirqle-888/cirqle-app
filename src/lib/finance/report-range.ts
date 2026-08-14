/**
 * Finance Engine — report date ranges (pure).
 *
 * Every financial report needs the same thing: turn URL params into an
 * inclusive `from`/`to` pair plus the months it covers. Two shapes are
 * supported and they are NOT equivalent:
 *
 *   PRESET  — "last N months", ending with the current month. Always lands on
 *             whole calendar months, so the profit engine (which is monthly and
 *             snapshot-aware) can be reconciled against exactly.
 *   CUSTOM  — an arbitrary from/to. Only month-ALIGNED custom ranges can
 *             reconcile; a range ending mid-month cannot, because a month's
 *             profit snapshot is indivisible.
 *
 * `monthAligned` is what callers branch on. Reporting a tie-out that silently
 * compared a half-month of revenue against a whole month of overhead would be
 * worse than reporting none, so the flag exists to make the caller choose.
 *
 * Dates resolve on the India business calendar via lib/utils/local-date —
 * never `new Date().toISOString()`, which is a different day from 00:00 to
 * 05:30 IST and shifts a locally-built date by a full day on a UTC server.
 */

import { lastDayOfMonthISO, monthEndISO, monthStartISO, todayISO } from '@/lib/utils/local-date'
import { monthRange } from './pnl'

/** Presets offered in the UI, in months. */
export const RANGE_PRESETS: readonly number[] = [1, 3, 6, 12, 24] as const

const DEFAULT_PRESET = 6
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export interface ReportRange {
  /** Inclusive YYYY-MM-DD. */
  from: string
  /** Inclusive YYYY-MM-DD. */
  to: string
  /**
   * Whole calendar months covered, ascending YYYY-MM. Populated only when the
   * range is month-aligned — a partial month is not a month.
   */
  months: string[]
  /** from is a 1st AND to is a month end. Only then can a caller reconcile. */
  monthAligned: boolean
  /** The preset that produced this, or null for a custom range. */
  presetMonths: number | null
}

const isIsoDate = (v: unknown): v is string =>
  typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))

/** True when `iso` is the last day of its own month. */
export function isMonthEnd(iso: string): boolean {
  const [y, m] = iso.split('-').map(Number)
  return iso === lastDayOfMonthISO(y, m)
}

/**
 * Resolve URL params into a range.
 *
 * A custom range wins over a preset when both are present and the custom one
 * is usable. Anything malformed — bad shape, reversed order — falls back to
 * the preset rather than throwing, because a report that 500s on a hand-edited
 * query string is worse than one that shows the default window.
 */
export function resolveReportRange(
  params: { months?: string | null; from?: string | null; to?: string | null },
  now: Date = new Date(),
): ReportRange {
  const from = params.from
  const to = params.to

  if (isIsoDate(from) && isIsoDate(to) && from <= to) {
    const aligned = from.endsWith('-01') && isMonthEnd(to)
    return {
      from,
      to,
      months: aligned ? monthRange(from.slice(0, 7), to.slice(0, 7)) : [],
      monthAligned: aligned,
      presetMonths: null,
    }
  }

  const parsed = parseInt(String(params.months ?? ''), 10)
  const presetMonths = Number.isFinite(parsed)
    ? Math.min(24, Math.max(1, parsed))
    : DEFAULT_PRESET

  // `offset` counts back from the current month, so N months INCLUDES this one.
  const start = monthStartISO(-(presetMonths - 1), now)
  const end = monthEndISO(0, now)
  return {
    from: start,
    to: end,
    months: monthRange(start.slice(0, 7), end.slice(0, 7)),
    monthAligned: true,
    presetMonths,
  }
}

/** `months` as the {month, year} pairs the profit engine takes. */
export function toProfitMonths(months: string[]): { month: number; year: number }[] {
  return months.map(m => {
    const [year, month] = m.split('-').map(Number)
    return { month, year }
  })
}

/**
 * Fraction of a calendar month covered by an inclusive range, 0–1.
 *
 * Used to pro-rate a monthly figure (base salaries) across a range that starts
 * or ends mid-month. Day-proportional is a CONVENTION, not a measurement — a
 * caller must label the result as apportioned.
 */
export function monthOverlapFraction(
  month: number,
  year: number,
  from: string,
  to: string,
): number {
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`
  const monthEnd = lastDayOfMonthISO(year, month)
  const lo = from > monthStart ? from : monthStart
  const hi = to < monthEnd ? to : monthEnd
  if (lo > hi) return 0

  const dayOf = (iso: string) => Number(iso.slice(8, 10))
  const daysInMonth = dayOf(monthEnd)
  const covered = dayOf(hi) - dayOf(lo) + 1
  return covered / daysInMonth
}

/** Human label for a range, e.g. "1 Mar 2026 – 14 Aug 2026". */
export function formatRangeLabel(range: ReportRange): string {
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number)
    // Constructed in UTC and read back in UTC — no zone can shift it.
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    })
  }
  return `${fmt(range.from)} – ${fmt(range.to)}`
}

/** Today on the business calendar — the default `to` for a custom picker. */
export const defaultCustomTo = (now: Date = new Date()): string => todayISO(now)
