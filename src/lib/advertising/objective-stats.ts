/**
 * The four headline numbers for a campaign card, chosen by objective.
 *
 * Cards used to show ROAS · CTR · CPC · Leads for every campaign, so an
 * awareness or messaging campaign read "ROAS 0.00× · Leads —". The result
 * metric and its cost now lead (result-type.ts definitions); awareness
 * campaigns lead with impressions and CPM; ROAS appears only when revenue is
 * actually tracked.
 */

import type { AggregateMetrics } from './reporting'
import { resultCount, costPerSelectedResult, type ResultDefinition } from '@/lib/reporting/result-type'

export interface StatTile { label: string; value: string }

const SHORT_COST: Record<string, string> = {
  leads: 'CPL', messages: 'Cost/conv.', purchases: 'Cost/purchase', clicks: 'CPC',
}
const SHORT_RESULT: Record<string, string> = {
  leads: 'Leads', messages: 'Conversations', purchases: 'Purchases', clicks: 'Clicks',
}

const inr = (v: number) => `₹${v.toLocaleString('en-IN', { maximumFractionDigits: v < 100 ? 2 : 0 })}`
const num = (v: number) => v.toLocaleString('en-IN')

export function objectiveStats(def: ResultDefinition, agg: AggregateMetrics): StatTile[] {
  const results = resultCount(def, agg)
  const cost = costPerSelectedResult(agg.spend, results)
  const spend: StatTile = { label: 'Spend', value: agg.spend > 0 ? inr(agg.spend) : '₹0' }
  const efficiency: StatTile = agg.revenue > 0
    ? { label: 'ROAS', value: `${agg.roas.toFixed(2)}×` }
    : { label: 'CTR', value: agg.impressions > 0 ? `${agg.ctr.toFixed(2)}%` : '—' }

  if (def.metric) {
    return [
      { label: SHORT_RESULT[def.metric] ?? def.label, value: results == null ? '—' : num(results) },
      { label: SHORT_COST[def.metric] ?? 'Cost/result', value: cost == null ? '—' : inr(cost) },
      spend,
      efficiency,
    ]
  }
  // No result metric (awareness, reach, installs, video views): delivery.
  return [
    { label: 'Impressions', value: agg.impressions > 0 ? num(agg.impressions) : '—' },
    { label: 'CPM', value: agg.impressions > 0 ? inr(agg.cpm) : '—' },
    spend,
    efficiency,
  ]
}
