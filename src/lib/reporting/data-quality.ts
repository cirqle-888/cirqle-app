/**
 * Report data coverage: which days in the period actually have a metric row.
 *
 * A day with a row whose spend is 0 is a ZERO-DELIVERY day — the campaign
 * really did not spend. A day with NO row is MISSING — it was never synced
 * (or failed to), so the report knows nothing about it. These used to look
 * identical: both simply contributed nothing, so a failed sync produced a
 * clean-looking report with smaller numbers.
 *
 * Expected days are the period clipped to the campaign's own dates and to
 * today (the future has no data yet, and today is partial).
 */

import { addDaysISO } from '@/lib/utils/local-date'

export interface DataQuality {
  /** Days in the period the campaign was running, up to today. */
  expectedDays: number
  /** Expected days that have a metric row. */
  recordedDays: number
  /** Recorded days with zero spend and zero impressions. */
  zeroDeliveryDays: number
  /** Expected days with no row (first 31 listed). */
  missingDates: string[]
  missingCount: number
  /** The period includes today, whose numbers are still changing. */
  includesToday: boolean
  lastSyncAt: string | null
  lastSyncError: string | null
}

/** At most this many missing dates are listed; missingCount has the total. */
const MAX_LISTED = 31

export function assessDataQuality(opts: {
  dateFrom: string
  dateTo: string
  campaignStart: string | null
  campaignEnd: string | null
  today: string
  rows: { date: string; spend: number; impressions: number }[]
  lastSyncAt?: string | null
  lastSyncError?: string | null
}): DataQuality {
  const { dateFrom, dateTo, campaignStart, campaignEnd, today, rows } = opts
  const from = campaignStart && campaignStart > dateFrom ? campaignStart : dateFrom
  let to = campaignEnd && campaignEnd < dateTo ? campaignEnd : dateTo
  if (today < to) to = today

  const byDate = new Map(rows.map(r => [r.date, r]))
  const missingDates: string[] = []
  let expectedDays = 0, recordedDays = 0, zeroDeliveryDays = 0, missingCount = 0

  // Bounded: config.ts caps a report at 400 days.
  for (let d = from; d && d <= to && expectedDays < 1000; d = addDaysISO(d, 1)) {
    expectedDays++
    const row = byDate.get(d)
    if (!row) {
      missingCount++
      if (missingDates.length < MAX_LISTED) missingDates.push(d)
    } else {
      recordedDays++
      if (!(row.spend > 0) && !(row.impressions > 0)) zeroDeliveryDays++
    }
  }

  return {
    expectedDays,
    recordedDays,
    zeroDeliveryDays,
    missingDates,
    missingCount,
    includesToday: dateFrom <= today && today <= dateTo,
    lastSyncAt: opts.lastSyncAt ?? null,
    lastSyncError: opts.lastSyncError ?? null,
  }
}

/** One plain sentence for a report, or null when coverage is complete. */
export function describeDataQuality(q: DataQuality | undefined): string | null {
  if (!q) return null
  const parts: string[] = []
  if (q.missingCount > 0) {
    parts.push(`No data was synced for ${q.missingCount} of ${q.expectedDays} day${q.expectedDays === 1 ? '' : 's'}`
      + (q.missingCount <= 5 ? ` (${q.missingDates.join(', ')})` : '')
      + ' — totals for this period are incomplete.')
  }
  if (q.includesToday) parts.push("Today's figures are partial and will change.")
  return parts.length > 0 ? parts.join(' ') : null
}
