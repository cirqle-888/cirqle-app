/**
 * Advertising — derived performance metrics (pure, unit-tested).
 *
 * Employees copy raw numbers from Meta/Google Ads Manager; these helpers fill in
 * the derived metrics (CTR, CPC, CPM, ROAS, …) when a column is left blank, and
 * roll daily rows up into period totals for reports. Every ratio returns `null`
 * when its denominator is missing/zero so the UI can render "—" instead of
 * Infinity/NaN. A value the employee typed always wins over a computed one.
 */

import type { AdCampaignType, AdDailyMetricRow } from './types'

const n = (v: unknown): number | null =>
  v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)
const round = (v: number, dp = 2): number => {
  const f = 10 ** dp
  return Math.round((v + Number.EPSILON) * f) / f
}

/** Click-through rate as a percentage: clicks / impressions × 100. */
export function ctr(clicks?: number | null, impressions?: number | null): number | null {
  const c = n(clicks), i = n(impressions)
  if (c == null || i == null || i <= 0) return null
  return round((c / i) * 100, 4)
}

/** Cost per click: spend / clicks. */
export function cpc(spend?: number | null, clicks?: number | null): number | null {
  const s = n(spend), c = n(clicks)
  if (s == null || c == null || c <= 0) return null
  return round(s / c, 4)
}

/** Cost per mille (per 1,000 impressions): spend / impressions × 1000. */
export function cpm(spend?: number | null, impressions?: number | null): number | null {
  const s = n(spend), i = n(impressions)
  if (s == null || i == null || i <= 0) return null
  return round((s / i) * 1000, 4)
}

/** Return on ad spend: revenue / spend (a multiple, e.g. 3.5×). */
export function roas(revenue?: number | null, spend?: number | null): number | null {
  const r = n(revenue), s = n(spend)
  if (r == null || s == null || s <= 0) return null
  return round(r / s, 4)
}

/** Average frequency: impressions / reach. */
export function frequency(impressions?: number | null, reach?: number | null): number | null {
  const i = n(impressions), r = n(reach)
  if (i == null || r == null || r <= 0) return null
  return round(i / r, 4)
}

/** Cost per result: spend / results. */
export function costPerResult(spend?: number | null, results?: number | null): number | null {
  const s = n(spend), r = n(results)
  if (s == null || r == null || r <= 0) return null
  return round(s / r, 4)
}

/** Remaining budget = budget − cumulative spend (never below 0 here is NOT enforced; can go negative to signal overspend). */
export function remainingBudget(budget?: number | null, cumulativeSpend?: number | null): number | null {
  const b = n(budget), s = n(cumulativeSpend)
  if (b == null) return null
  return round(b - (s ?? 0), 2)
}

/**
 * The "primary result" count for a campaign, used for cost-per-result.
 * Picks the count that matches the campaign objective, falling back sensibly.
 */
export function primaryResult(
  row: Partial<AdDailyMetricRow>,
  campaignType?: AdCampaignType | string | null,
): number | null {
  const pick = (...vals: (number | null | undefined)[]) => {
    for (const v of vals) { const x = n(v); if (x != null) return x }
    return null
  }
  switch (campaignType) {
    case 'leads':       return pick(row.leads, row.conversions)
    case 'messages':    return pick(row.messages, row.conversions)
    case 'sales':
    case 'conversion':  return pick(row.purchases, row.conversions)
    case 'app_install': return pick(row.conversions)
    case 'video_views': return pick(row.video_views)
    case 'traffic':     return pick(row.clicks)
    default:            return pick(row.conversions, row.leads, row.purchases, row.clicks)
  }
}

export interface DerivedMetrics {
  spend: number | null
  revenue: number | null
  impressions: number | null
  reach: number | null
  clicks: number | null
  ctr: number | null
  cpc: number | null
  cpm: number | null
  roas: number | null
  frequency: number | null
  resultCost: number | null
  results: number | null
}

/**
 * Fill derived metrics from a (partial) daily row. Any value already present on
 * the row is preserved; only blanks are computed. `campaignType` selects which
 * count drives cost-per-result.
 */
export function deriveMetrics(
  row: Partial<AdDailyMetricRow>,
  campaignType?: AdCampaignType | string | null,
): DerivedMetrics {
  const spend = n(row.spend)
  const revenue = n(row.revenue)
  const impressions = n(row.impressions)
  const reach = n(row.reach)
  const clicks = n(row.clicks)
  const results = primaryResult(row, campaignType)
  return {
    spend,
    revenue,
    impressions,
    reach,
    clicks,
    ctr:        n(row.ctr)         ?? ctr(clicks, impressions),
    cpc:        n(row.cpc)         ?? cpc(spend, clicks),
    cpm:        n(row.cpm)         ?? cpm(spend, impressions),
    roas:       n(row.roas)        ?? roas(revenue, spend),
    frequency:  n(row.frequency)   ?? frequency(impressions, reach),
    resultCost: n(row.result_cost) ?? n(row.cpr) ?? costPerResult(spend, results),
    results,
  }
}

export interface MetricsAggregate {
  days: number
  spend: number
  revenue: number
  impressions: number
  reach: number
  clicks: number
  conversions: number
  leads: number
  messages: number
  purchases: number
  videoViews: number
  // Recomputed from the summed raw values (NOT averaged — the correct way).
  ctr: number | null
  cpc: number | null
  cpm: number | null
  roas: number | null
}

/**
 * Roll daily rows up to a period total. Ratios are recomputed from the summed
 * raw values (averaging daily ratios would be wrong). Used by weekly/monthly/
 * campaign reports.
 */
export function aggregateMetrics(rows: Partial<AdDailyMetricRow>[]): MetricsAggregate {
  const sum = (key: keyof AdDailyMetricRow) =>
    rows.reduce((t, r) => t + (n(r[key]) ?? 0), 0)

  const spend = round(sum('spend'))
  const revenue = round(sum('revenue'))
  const impressions = sum('impressions')
  const reach = sum('reach')
  const clicks = sum('clicks')

  return {
    days: rows.length,
    spend,
    revenue,
    impressions,
    reach,
    clicks,
    conversions: sum('conversions'),
    leads: sum('leads'),
    messages: sum('messages'),
    purchases: sum('purchases'),
    videoViews: sum('video_views'),
    ctr:  ctr(clicks, impressions),
    cpc:  cpc(spend, clicks),
    cpm:  cpm(spend, impressions),
    roas: roas(revenue, spend),
  }
}
