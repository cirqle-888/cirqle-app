/**
 * Reporting Engine for Advertising ERP.
 * 
 * Never calculate ROAS, CTR, CPC, etc., inside React components.
 * This engine handles all aggregations, currency conversions, and calculations
 * to guarantee identical numbers across dashboards, exports, and AI forecasts.
 */

import { AdDailyMetricRow } from './types'

export interface AggregateMetrics {
  spend: number
  revenue: number
  impressions: number
  clicks: number
  reach: number
  leads: number
  conversions: number
  days: number
  
  roas: number
  ctr: number
  cpc: number
  cpm: number
  cpl: number
  cpa: number
}

/**
 * Safely sums an array of metrics.
 * Applies exchange rates stored on the rows to ensure all sums are in the Base Currency.
 */
export function aggregateMetrics(metrics: Partial<AdDailyMetricRow>[]): AggregateMetrics {
  let spend = 0
  let revenue = 0
  let impressions = 0
  let clicks = 0
  let reach = 0
  let leads = 0
  let conversions = 0
  let days = 0

  for (const m of metrics) {
    // If the pipeline correctly stamped exchange_rate_ad_to_base, use it.
    // Otherwise fallback to 1.0 (assuming they are already in base, or rate is 1:1).
    const rate = Number(m.exchange_rate_ad_to_base || 1.0)
    
    spend += Number(m.spend || 0) * rate
    revenue += Number(m.revenue || 0) * rate
    impressions += Number(m.impressions || 0)
    clicks += Number(m.clicks || 0)
    reach += Number(m.reach || 0)
    leads += Number(m.leads || 0)
    conversions += Number(m.conversions || 0)
    days += 1
  }

  return {
    spend,
    revenue,
    impressions,
    clicks,
    reach,
    leads,
    conversions,
    days,
    roas: spend > 0 ? revenue / spend : 0,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
    cpl: leads > 0 ? spend / leads : 0,
    cpa: leads > 0 ? spend / leads : 0, // In many contexts, Leads = Actions, but can be split later if needed
  }
}

/**
 * Groups metrics by a specific temporal period
 */
export function aggregateByPeriod(
  metrics: Partial<AdDailyMetricRow>[], 
  period: 'daily' | 'weekly' | 'monthly'
): Record<string, AggregateMetrics> {
  const groups: Record<string, Partial<AdDailyMetricRow>[]> = {}

  for (const m of metrics) {
    if (!m.metric_date) continue
    const date = new Date(m.metric_date)
    let key = m.metric_date

    if (period === 'monthly') {
      key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    } else if (period === 'weekly') {
      // Find Monday of the week
      const day = date.getDay() || 7
      if (day !== 1) date.setHours(-24 * (day - 1))
      key = date.toISOString().slice(0, 10)
    }
    
    if (!groups[key]) groups[key] = []
    groups[key].push(m)
  }

  const result: Record<string, AggregateMetrics> = {}
  for (const [key, rows] of Object.entries(groups)) {
    result[key] = aggregateMetrics(rows)
  }
  return result
}

/**
 * Basic health score logic (placeholder for AI extension).
 * 0-100 scale.
 */
export function healthScore(agg: AggregateMetrics, budget: number): number {
  if (budget <= 0 || agg.spend === 0) return 100
  let score = 100

  if (agg.roas < 1.0) score -= 30
  else if (agg.roas < 2.0) score -= 10

  if (agg.ctr < 0.5) score -= 15

  const spendRatio = agg.spend / budget
  if (spendRatio > 0.9 && agg.roas < 1.0) score -= 20

  return Math.max(0, Math.min(100, Math.round(score)))
}
