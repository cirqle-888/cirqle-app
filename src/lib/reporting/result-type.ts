/**
 * Which metric counts as a campaign's "result".
 *
 * Cost per result used to be `spend / (leads || conversions || clicks)`: a
 * lead campaign that got 0 leads and 50 clicks showed CPR ₹10 — a click cost
 * shown under a lead label, i.e. a failing campaign reported as a cheap
 * success. The result is now picked ONCE from the campaign objective and
 * never swapped for another metric because the first one happens to be zero.
 *
 * Objectives whose result we do not ingest (app installs, video views)
 * return `null`: cost per result is "not available", not ₹0 and not a click
 * cost. Awareness/reach campaigns are judged on reach and CPM, so they also
 * have no cost per result.
 *
 * Messages and purchases are imported from Meta since definition v2. Rows
 * synced before that hold NULL for them — "not recorded", which is counted
 * as missing coverage, never as zero results.
 *
 * Bump RESULT_DEFINITION_VERSION when this mapping changes so stored report
 * snapshots record which definition produced their numbers.
 */

export const RESULT_DEFINITION_VERSION = 2

/** Column on ad_daily_metrics that holds the result count. */
export type ResultMetric = 'leads' | 'messages' | 'purchases' | 'clicks'

export interface ResultDefinition {
  metric: ResultMetric | null
  /** Plural label, e.g. "Leads". */
  label: string
  /** Label for spend ÷ result, e.g. "Cost per lead". */
  costLabel: string
  /** Why there is no result metric, when `metric` is null. */
  unavailableReason?: string
  version: number
}

const def = (metric: ResultMetric | null, label: string, costLabel: string, unavailableReason?: string): ResultDefinition =>
  ({ metric, label, costLabel, ...(unavailableReason ? { unavailableReason } : {}), version: RESULT_DEFINITION_VERSION })

/**
 * @param campaignType the project's Cirqle campaign_type (see campaign-objective.ts)
 * @param totals       period totals — used ONLY for campaigns with no objective
 *                     set, to keep reporting leads for the lead campaigns that
 *                     predate the field. Never used to switch metrics.
 */
export function resultDefinitionFor(
  campaignType: string | null | undefined,
  totals?: { leads?: number },
): ResultDefinition {
  switch (campaignType) {
    case 'leads':
      return def('leads', 'Leads', 'Cost per lead')
    case 'sales':
    case 'conversion':
    case 'remarketing':
      return def('purchases', 'Purchases', 'Cost per purchase')
    case 'traffic':
    case 'engagement':
      // Meta's `clicks` field is ALL clicks, not link clicks or landing-page views.
      return def('clicks', 'Clicks (all)', 'Cost per click')
    case 'awareness':
    case 'reach':
      return def(null, 'Results', 'Cost per result', 'Awareness campaigns are measured by reach and CPM.')
    case 'messages':
      return def('messages', 'Conversations', 'Cost per conversation')
    case 'app_install':
      return def(null, 'Installs', 'Cost per install', 'App installs are not imported yet.')
    case 'video_views':
      return def(null, 'Video views', 'Cost per view', 'Video views are not imported yet.')
    case 'mixed':
      // A client report over campaigns with different objectives: there is no
      // one result to add up — each campaign's result is in the breakdown.
      return def(null, 'Results', 'Cost per result', 'Campaigns have different objectives — see the per-campaign breakdown.')
    default:
      if ((totals?.leads ?? 0) > 0) return def('leads', 'Leads', 'Cost per lead')
      return def(null, 'Results', 'Cost per result', 'Set the campaign objective to choose its result.')
  }
}

export interface ResultTotals {
  leads: number
  clicks: number
  days?: number
  messages?: number
  purchases?: number
  messagesDays?: number
  purchasesDays?: number
}

/**
 * Result count for a set of totals. null when the objective has no result
 * metric, or when no day in the set recorded it (synced before it was
 * imported).
 */
export function resultCount(definition: ResultDefinition, totals: ResultTotals): number | null {
  // No rows at all = nothing is known, not "0 results".
  if (totals.days === 0) return null
  switch (definition.metric) {
    case 'leads':     return totals.leads
    case 'clicks':    return totals.clicks
    case 'messages':  return totals.messagesDays ? totals.messages ?? 0 : null
    case 'purchases': return totals.purchasesDays ? totals.purchases ?? 0 : null
    default:          return null
  }
}

/** Days in `totals` that recorded the result metric, out of all days. */
export function resultCoverage(
  definition: ResultDefinition,
  totals: ResultTotals,
): { recordedDays: number; days: number } | null {
  const days = totals.days ?? 0
  switch (definition.metric) {
    case 'messages':  return { recordedDays: totals.messagesDays ?? 0, days }
    case 'purchases': return { recordedDays: totals.purchasesDays ?? 0, days }
    case 'leads':
    case 'clicks':    return { recordedDays: days, days }
    default:          return null
  }
}

/** Spend ÷ results; null when there is no result metric or no results. */
export function costPerSelectedResult(spend: number, results: number | null): number | null {
  if (results == null || results <= 0) return null
  return spend / results
}

/**
 * Signed % change from baseline to current. `null` when the baseline is zero
 * (or either side is unavailable) — growth from nothing is "new", not +100%.
 */
export function pctChange(current: number | null | undefined, baseline: number | null | undefined): number | null {
  if (current == null || baseline == null || !Number.isFinite(current) || !Number.isFinite(baseline)) return null
  if (baseline === 0) return current === 0 ? 0 : null
  return ((current - baseline) / baseline) * 100
}
