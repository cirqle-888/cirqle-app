import { round2 } from '@/lib/calculations/currency'
import type { DayTotal, EntityTotal, MonthAggregate } from './historical'
import { aggregateByMonth, mergeMonths, type AnalyticsTask } from './historical'

/**
 * One view of the analytics window, however it was assembled.
 *
 * The dashboard has eight consumers of "the last 36 months of tasks". Rather
 * than teach each of them about caching, they all read THIS: a plain object
 * with the numbers they were computing for themselves. Where those numbers
 * came from — a cached aggregate for a closed month, live rows for the current
 * one — stops mattering above this line.
 *
 * `days` is what makes the split honest. The trend graph draws a wave and the
 * date filter offers "last 7 days" and custom ranges; neither can be answered
 * from month totals. Carrying day rows costs a fraction of carrying task rows
 * and keeps every existing feature working at full resolution.
 *
 * PURE. No cache, no fetch, no React.
 */

export interface AnalyticsView {
  months: MonthAggregate[]
  days: DayTotal[]
  taskValue: number
  taskCount: number
  revenue: number
  creativeCount: number
  byClient: EntityTotal[]
  byService: EntityTotal[]
}

/**
 * Join the cached history to the live current month.
 *
 * `liveTasks` are real rows — the current month, always fetched fresh. They
 * are aggregated here so the rest of the dashboard cannot tell the two halves
 * apart, which is the only way the seam stays invisible as months roll over.
 *
 * A month present in BOTH wins from the live side: if the window ever overlaps,
 * fresh rows are by definition more correct than a cached aggregate of them.
 */
export function buildView(
  historical: readonly MonthAggregate[],
  liveTasks: readonly AnalyticsTask[],
): AnalyticsView {
  const live = aggregateByMonth(liveTasks)
  const liveMonths = new Set(live.map(m => m.month))
  const months = [...historical.filter(m => !liveMonths.has(m.month)), ...live]
    .sort((a, b) => a.month.localeCompare(b.month))

  const merged = mergeMonths(months)
  return { months, ...merged }
}

/** An inclusive date window, as the date filter expresses one. */
export interface DateWindow {
  from: string   // 'YYYY-MM-DD'
  to: string     // 'YYYY-MM-DD'
}

/**
 * Narrow a view to a date window using day rows.
 *
 * Month totals are rebuilt from the days that fall inside, so `taskValue`,
 * `taskCount` and `creativeCount` are exact for ANY window — including one
 * that starts mid-month.
 *
 * WHAT IT CANNOT DO EXACTLY: the per-client and per-service splits. Those are
 * only held per month, so a window covering part of a month cannot apportion
 * them honestly. Rather than scale them — which would invent a number — this
 * reports `clientSplitExact: false` and includes whole months only, and the
 * caller decides whether to show the split or fetch rows for that window.
 */
export function sliceView(view: AnalyticsView, window: DateWindow): AnalyticsView & { clientSplitExact: boolean } {
  const days = view.days.filter(d => d.date >= window.from && d.date <= window.to)

  const taskValue = days.reduce((s, d) => s + d.value, 0)
  const taskCount = days.reduce((s, d) => s + d.count, 0)
  const creativeCount = days.reduce((s, d) => s + d.quantity, 0)

  // A month is wholly inside the window when its first and last possible day
  // are both covered. Only those contribute their client/service split.
  const wholeMonths = view.months.filter(m => monthFullyInside(m.month, window))
  const splitSource = mergeMonths(wholeMonths)
  const clientSplitExact = wholeMonths.length === monthsTouched(days).length

  return {
    months: view.months.filter(m => monthsTouched(days).includes(m.month)),
    days,
    taskValue: round2(taskValue),
    taskCount,
    // Revenue is billable-only and held per month, so a partial month cannot
    // give an exact figure; whole months inside the window are summed.
    revenue: splitSource.revenue,
    creativeCount,
    byClient: splitSource.byClient,
    byService: splitSource.byService,
    clientSplitExact,
  }
}

/** The months any of these days fall in. */
function monthsTouched(days: readonly DayTotal[]): string[] {
  return [...new Set(days.map(d => d.date.slice(0, 7)))].sort()
}

/** Is every day of `month` inside the window? */
function monthFullyInside(month: string, w: DateWindow): boolean {
  const first = `${month}-01`
  const [y, m] = month.split('-').map(Number)
  const last = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
  return first >= w.from && last <= w.to
}
