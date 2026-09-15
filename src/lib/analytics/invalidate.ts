import 'server-only'
import { revalidateTag } from 'next/cache'
import { ANALYTICS_TAG, analyticsMonthTag } from './cache'
import { monthKey } from './historical'
import { todayISO } from '@/lib/utils/local-date'

/**
 * Busting the historical analytics cache when history actually changes.
 *
 * A back-dated task, a corrected contribution, an invoice moved to last
 * month — each makes a cached aggregate wrong, and waiting up to 24 hours for
 * the TTL to notice is not good enough for money on a dashboard. So every
 * write that lands in a PAST month clears that month's tag.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO:
 *
 * 1. It does not bust for a CURRENT-month write. The current month is never
 *    cached, so there is nothing to bust — and clearing history on every
 *    ordinary save would make the cache useless, which is the failure mode
 *    where somebody concludes "the cache does nothing" and removes it.
 *
 * 2. It does not reach into a LOCKED month. `period_locks` and
 *    `profit_snapshots` exist so a closed book stops moving; `persistProfitSnapshot`
 *    already refuses to re-freeze for exactly this reason. If a write somehow
 *    lands in a locked month, the frozen figures are the correct answer and
 *    re-reading the rows would contradict them.
 *
 * Never throws. A cache that fails to bust is a stale number for up to a day;
 * a cache that throws is a failed save.
 */

/** The current month in the app's own calendar (Asia/Kolkata). */
export function currentMonthKey(): string {
  return todayISO().slice(0, 7)
}

/**
 * Invalidate the cached aggregates for the month a date falls in.
 *
 * Pass the task/entry date, not "now". Returns what it did, so a caller that
 * wants to log or test it can.
 */
export async function invalidateAnalyticsForDate(
  date: string | null | undefined,
  opts: { isMonthLocked?: (month: string) => Promise<boolean> } = {},
): Promise<{ busted: boolean; month: string | null; reason?: string }> {
  const month = monthKey(date)
  if (!month) return { busted: false, month: null, reason: 'no usable date' }

  if (month >= currentMonthKey()) {
    return { busted: false, month, reason: 'current or future month is never cached' }
  }

  if (opts.isMonthLocked) {
    try {
      if (await opts.isMonthLocked(month)) {
        return { busted: false, month, reason: 'month is locked; its figures are frozen' }
      }
    } catch {
      // Unknown lock state: bust anyway. A needless bust costs one query; a
      // skipped bust on an unlocked month leaves a wrong number on screen.
    }
  }

  try {
    // Next 16 requires a cache profile. 'max' matches the company-settings
    // call in settings/actions.ts — bust it everywhere, immediately.
    revalidateTag(analyticsMonthTag(month), 'max')
    return { busted: true, month }
  } catch {
    return { busted: false, month, reason: 'revalidateTag unavailable in this context' }
  }
}

/** Clear every cached month. For a bulk import or a recalc that spans months. */
export async function invalidateAllAnalytics(): Promise<void> {
  try {
    revalidateTag(ANALYTICS_TAG, 'max')
  } catch {
    /* nothing to do — the TTL still applies */
  }
}

/**
 * The lock check every real caller should use.
 *
 * `isMonthFinalized` is the canonical answer to "is this month closed" —
 * finalized payroll OR an explicit `period_locks` row — and it fails CLOSED.
 * Reusing it means the cache cannot disagree with payroll about what a closed
 * month is, which is the whole reason it is not re-implemented here.
 */
export async function monthIsLocked(month: string): Promise<boolean> {
  const [y, m] = month.split('-').map(Number)
  if (!y || !m) return false
  const { createAdminClient } = await import('@/lib/supabase/admin')
  const { isMonthFinalized } = await import('@/lib/payroll/compute')
  return isMonthFinalized(createAdminClient(), m, y)
}

/**
 * Bust every month touched by a set of dates.
 *
 * Takes DATES rather than months because callers hold task dates, and a task
 * that moves from March to April has to clear both — pass the old date and the
 * new one and this sorts it out. Deduplicates first, so a bulk edit of 200
 * rows in one month costs one lock check, not 200.
 */
export async function invalidateAnalyticsForDates(
  dates: readonly (string | null | undefined)[],
): Promise<string[]> {
  const months = new Set<string>()
  for (const d of dates) {
    const m = monthKey(d)
    if (m && m < currentMonthKey()) months.add(m)
  }
  const busted: string[] = []
  for (const month of months) {
    const r = await invalidateAnalyticsForDate(`${month}-01`, { isMonthLocked: monthIsLocked })
    if (r.busted) busted.push(month)
  }
  return busted
}
