/**
 * Per-client work and money over time, bucketed and comparable (pure).
 *
 * The dashboard's trend graph already answers "how did the company do this
 * quarter against last" — src/lib/finance/trends.ts resolves the periods and
 * this reuses that resolution verbatim. What it could not answer is the same
 * question for ONE client, because the client dimension is aggregated away
 * before the chart ever sees it: DashboardTrendGraph is handed
 * `{task_date, billing_amount_inr}` day totals and nothing else.
 *
 * WHY NOT THE CACHED AGGREGATES. src/lib/analytics/historical.ts does keep
 * per-client revenue and volume, but only per MONTH — its `DayTotal` carries
 * no client split, deliberately, because that would multiply the payload by
 * every client who worked that day. Week and month comparisons need DAILY
 * buckets, so the cache cannot serve them. A narrow live query can: the whole
 * task table is ~2,000 rows over three years, and five columns of two years
 * of it is tens of KB — nothing like the 634 KB of joined rows the cache was
 * built to avoid.
 *
 * THE ONE ASYMMETRY, kept from the live dashboard and from historical.ts:
 * `valueInr` counts EVERY task because that is work done, and `revenueInr`
 * counts only billable ones because a waived job brought nothing in. They are
 * different questions and the page shows both; summing them would be wrong.
 */

import {
  bucketKeys, bucketKeyFor, bucketLabel,
  type PeriodRange, type TrendGranularity,
} from '@/lib/finance/trends'

/** One task, reduced to what a client series needs. */
export interface ClientTaskPoint {
  clientId: string | null
  /** 'YYYY-MM-DD'. */
  date: string | null
  /** `billing_amount_inr` — already the task total, never a unit price. */
  valueInr: number
  billable: boolean
  /** Creatives produced. The production counter sums this, not rows. */
  quantity: number
}

export interface ClientBucket {
  key: string
  label: string
  /** Tasks received in this bucket. */
  jobs: number
  /** Value of all of them, waived included. */
  valueInr: number
  /** Value of the billable ones only. */
  revenueInr: number
  /** Sum of quantity — creatives, which is not the same as tasks. */
  creatives: number
}

export interface ClientTotals {
  jobs: number
  valueInr: number
  revenueInr: number
  creatives: number
}

/** The four things this page can plot. */
export type ClientMetric = 'jobs' | 'valueInr' | 'revenueInr' | 'creatives'

export const METRIC_LABELS: Record<ClientMetric, string> = {
  jobs: 'Jobs',
  valueInr: 'Job value',
  revenueInr: 'Billable revenue',
  creatives: 'Creatives',
}

/** Money metrics format as rupees; the other two are plain counts. */
export function isMoneyMetric(m: ClientMetric): boolean {
  return m === 'valueInr' || m === 'revenueInr'
}

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100

/**
 * Bucket one client's tasks across a period.
 *
 * `clientId` of null means "every client", which is how the page draws the
 * agency total alongside the ones picked.
 */
export function buildClientSeries(
  points: readonly ClientTaskPoint[],
  clientId: string | null,
  period: PeriodRange,
  granularity: TrendGranularity,
): ClientBucket[] {
  const keys = bucketKeys(period, granularity)
  const index = new Map<string, ClientBucket>(keys.map(k => [k, {
    key: k, label: bucketLabel(k, granularity),
    jobs: 0, valueInr: 0, revenueInr: 0, creatives: 0,
  }]))

  for (const p of points) {
    if (!p.date || p.date < period.from || p.date > period.to) continue
    if (clientId !== null && p.clientId !== clientId) continue
    const b = index.get(bucketKeyFor(p.date, granularity))
    if (!b) continue
    const value = Number(p.valueInr) || 0
    b.jobs += 1
    b.valueInr = r2(b.valueInr + value)
    if (p.billable) b.revenueInr = r2(b.revenueInr + value)
    b.creatives += Number(p.quantity) || 0
  }
  return keys.map(k => index.get(k)!)
}

export function seriesTotals(buckets: readonly ClientBucket[]): ClientTotals {
  return {
    jobs: buckets.reduce((s, b) => s + b.jobs, 0),
    valueInr: r2(buckets.reduce((s, b) => s + b.valueInr, 0)),
    revenueInr: r2(buckets.reduce((s, b) => s + b.revenueInr, 0)),
    creatives: buckets.reduce((s, b) => s + b.creatives, 0),
  }
}

/**
 * Clients ordered by what they were worth in a period, biggest first.
 *
 * Ranked on billable revenue rather than job value: a client given a lot of
 * waived work is not thereby a bigger client, and the ranking is what decides
 * whose series the page offers first.
 */
export function rankClients(
  points: readonly ClientTaskPoint[],
  period: PeriodRange,
  names: ReadonlyMap<string, string>,
): { id: string; name: string; revenueInr: number; jobs: number }[] {
  const acc = new Map<string, { revenueInr: number; jobs: number }>()
  for (const p of points) {
    if (!p.clientId || !p.date || p.date < period.from || p.date > period.to) continue
    const cur = acc.get(p.clientId) ?? { revenueInr: 0, jobs: 0 }
    cur.jobs += 1
    if (p.billable) cur.revenueInr = r2(cur.revenueInr + (Number(p.valueInr) || 0))
    acc.set(p.clientId, cur)
  }
  return [...acc].map(([id, v]) => ({ id, name: names.get(id) ?? 'Unknown client', ...v }))
    .sort((a, b) => b.revenueInr - a.revenueInr || b.jobs - a.jobs)
}

/** One chart row: a bucket, every selected client's value in it, and the
 * same-index bucket from the previous period. */
export type MultiRow = Record<string, string | number | undefined> & { label: string }

/**
 * Zip several clients' series into rows Recharts can draw directly.
 *
 * Current-period values are keyed `c_<clientId>` and previous-period ones
 * `p_<clientId>`. Buckets align by INDEX, not by date — day 1 of this month
 * against day 1 of last — which is how period-over-period charts line up and
 * what the company graph already does.
 */
export function alignClientSeries(
  current: ReadonlyMap<string, ClientBucket[]>,
  previous: ReadonlyMap<string, ClientBucket[]>,
  metric: ClientMetric,
): MultiRow[] {
  const lengths = [...current.values(), ...previous.values()].map(s => s.length)
  const n = lengths.length ? Math.max(...lengths) : 0
  const rows: MultiRow[] = []
  for (let i = 0; i < n; i++) {
    let label = ''
    let prevLabel: string | undefined
    for (const s of current.values()) if (s[i]) { label = s[i].label; break }
    for (const s of previous.values()) if (s[i]) { prevLabel = s[i].label; break }
    const row: MultiRow = { label: label || prevLabel || '' }
    if (prevLabel) row.prevLabel = prevLabel
    for (const [id, s] of current) if (s[i]) row[`c_${id}`] = s[i][metric]
    for (const [id, s] of previous) if (s[i]) row[`p_${id}`] = s[i][metric]
    rows.push(row)
  }
  return rows
}

/** % change (1 decimal), null when there is nothing to compare against. */
export function deltaPct(current: number, previous: number | undefined | null): number | null {
  if (previous == null || previous === 0) return null
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10
}
