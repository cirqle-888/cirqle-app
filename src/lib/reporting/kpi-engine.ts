/**
 * KPI Engine
 *
 * Wraps the existing aggregateMetrics() and aggregateByPeriod() from
 * src/lib/advertising/reporting.ts. Adds:
 *   • Comparison deltas
 *   • Daily + weekly series for charts
 *   • Derived KPIs (revenue − ad spend, margin, ROI, budget utilisation)
 *
 * Results follow the campaign objective (result-type.ts). A ratio whose
 * denominator is zero is `null` — "not available" — never a numeric 0 that
 * a renderer would show as a free lead or a 100% improvement.
 *
 * All monetary values are in INR (base currency) — exchange-rate
 * conversion has already been applied by the Data Engine.
 */

import { aggregateMetrics, aggregateByPeriod } from '@/lib/advertising/reporting'
import { AD_SPEND_GST_RATE } from '@/lib/advertising/budget'
import { resultDefinitionFor, resultCount, resultCoverage, costPerSelectedResult, pctChange } from './result-type'
import type {
  KPIData, KPIDeltas, DailySeriesPoint, WeeklySeriesPoint, DerivedKPIs,
} from './types'
import type { ReportMetricRow, ReportProject } from './types'
import type { PeriodReach } from '@/lib/advertising/period-reach'

/**
 * Builds the full KPIData object from raw metric rows.
 * @param metrics      Primary period rows (output of data-engine)
 * @param comparison   Comparison period rows (may be empty)
 * @param project      Project row for budget context
 */
export function buildKPIData(
  metrics: ReportMetricRow[],
  comparison: ReportMetricRow[],
  project: ReportProject,
  reach?: { period?: PeriodReach; comparison?: PeriodReach },
): KPIData {
  // ── Convert ReportMetricRows → Partial<AdDailyMetricRow> for existing helpers
  // GST on ad-platform spend is a fixed rate (not the project's own configurable
  // invoice tax_percent, which is a separate concept and may legitimately be 0).
  const taxMultiplier = 1 + AD_SPEND_GST_RATE
  const toAdRows = (rows: ReportMetricRow[]) =>
    rows.map(r => ({
      metric_date: r.date,
      spend: r.spend, // Raw Meta Spend (excluding GST)
      revenue: r.revenue,
      impressions: r.impressions,
      clicks: r.clicks,
      reach: r.reach,
      leads: r.leads,
      conversions: r.conversions,
      messages: r.messages ?? null,
      purchases: r.purchases ?? null,
      landing_page_views: r.landingPageViews ?? null,
      exchange_rate_ad_to_base: 1, // already converted
    }))

  const primaryAdRows = toAdRows(metrics)
  const compAdRows = toAdRows(comparison)

  // ── Primary aggregate ───────────────────────────────────────────────────
  const primary = aggregateMetrics(primaryAdRows)

  // ── Comparison aggregate ────────────────────────────────────────────────
  const comp = comparison.length > 0 ? aggregateMetrics(compAdRows) : undefined

  // ── Result definition: chosen once, from the objective ─────────────────
  const result = resultDefinitionFor(project.campaignType, { leads: primary.leads })

  // ── Deltas ──────────────────────────────────────────────────────────────
  // Ratios only compare where they exist on both sides (CPL with 0 leads is
  // undefined, not ₹0).
  const ratio = (a: typeof primary, key: 'roas' | 'ctr' | 'cpc' | 'cpm' | 'cpl') => {
    switch (key) {
      case 'roas': return a.spend > 0 && a.revenue > 0 ? a.roas : null
      case 'ctr':  return a.impressions > 0 ? a.ctr : null
      case 'cpc':  return a.clicks > 0 ? a.cpc : null
      case 'cpm':  return a.impressions > 0 ? a.cpm : null
      case 'cpl':  return a.leads > 0 ? a.cpl : null
    }
  }
  const compResults = comp ? resultCount(result, comp) : null
  const primaryResults = resultCount(result, primary)
  const deltas: KPIDeltas | undefined = comp
    ? {
        spendDelta:       pctChange(primary.spend, comp.spend),
        revenueDelta:     pctChange(primary.revenue, comp.revenue),
        impressionsDelta: pctChange(primary.impressions, comp.impressions),
        clicksDelta:      pctChange(primary.clicks, comp.clicks),
        // Only unique period reach is comparable; a change in summed daily
        // reach mixes audience size with how often people were reached.
        reachDelta:       reach?.period?.available && reach.comparison?.available
          ? pctChange(reach.period.value, reach.comparison.value)
          : null,
        leadsDelta:       pctChange(primary.leads, comp.leads),
        roasDelta:        pctChange(ratio(primary, 'roas'), ratio(comp, 'roas')),
        ctrDelta:         pctChange(ratio(primary, 'ctr'), ratio(comp, 'ctr')),
        cpcDelta:         pctChange(ratio(primary, 'cpc'), ratio(comp, 'cpc')),
        cpmDelta:         pctChange(ratio(primary, 'cpm'), ratio(comp, 'cpm')),
        cplDelta:         pctChange(ratio(primary, 'cpl'), ratio(comp, 'cpl')),
        resultsDelta:     pctChange(primaryResults, compResults),
        costPerResultDelta: pctChange(
          costPerSelectedResult(primary.spend, primaryResults),
          costPerSelectedResult(comp.spend, compResults),
        ),
      }
    : undefined

  // ── Daily series ────────────────────────────────────────────────────────
  const dailyGroups = aggregateByPeriod(primaryAdRows, 'daily')
  const dailySeries: DailySeriesPoint[] = Object.entries(dailyGroups)
    .sort(([a], [b]) => b.localeCompare(a)) // Sort by date descending (newest first)
    .map(([date, agg]) => {
      const dayResults = resultCount(result, agg)
      return {
        date,
        spend: agg.spend,
        revenue: agg.revenue,
        impressions: agg.impressions,
        clicks: agg.clicks,
        reach: agg.reach,
        leads: agg.leads,
        roas: agg.roas,
        ctr: agg.ctr,
        results: dayResults,
        cpr: costPerSelectedResult(agg.spend, dayResults),
        actualCost: agg.spend * taxMultiplier,
        gstAmount: agg.spend * (taxMultiplier - 1),
        remainingAllocation: 0, // Computed cumulatively in layout rendering
      }
    })

  // ── Weekly series ───────────────────────────────────────────────────────
  const weeklyGroups = aggregateByPeriod(primaryAdRows, 'weekly')
  const weeklySeries: WeeklySeriesPoint[] = Object.entries(weeklyGroups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, agg]) => {
      const weekResults = resultCount(result, agg)
      return {
        date,
        weekLabel: `w/c ${date}`,
        spend: agg.spend,
        revenue: agg.revenue,
        impressions: agg.impressions,
        clicks: agg.clicks,
        reach: agg.reach,
        leads: agg.leads,
        roas: agg.roas,
        ctr: agg.ctr,
        results: weekResults,
        cpr: costPerSelectedResult(agg.spend, weekResults),
        actualCost: agg.spend * taxMultiplier,
        gstAmount: agg.spend * (taxMultiplier - 1),
        remainingAllocation: 0,
      }
    })

  // ── Derived KPIs ────────────────────────────────────────────────────────
  // `profit` is platform-attributed revenue minus ad spend — NOT business
  // profit (no product, service or overhead cost is known here). The field
  // name is kept for stored snapshots; every label says what it really is.
  const profit = primary.revenue - primary.spend
  const budget = project.adBudget
  const walletAllocation = project.walletAllocation || 0
  const openingBalance = project.openingBalance ?? walletAllocation
  const actualCost = primary.spend * taxMultiplier
  const gstAmount = primary.spend * (taxMultiplier - 1)
  const remainingAllocation = openingBalance - actualCost
  const results = resultCount(result, primary)
  const campaignDays = metrics.length
  const costToDate = ((project.priorSpend ?? 0) + primary.spend) * taxMultiplier

  const derived: DerivedKPIs = {
    profit,
    margin: primary.revenue > 0 ? (profit / primary.revenue) * 100 : 0,
    roi: primary.spend > 0 ? (profit / primary.spend) * 100 : 0,
    conversionRate: primary.clicks > 0 ? (primary.leads / primary.clicks) * 100 : 0,
    costPerResult: costPerSelectedResult(primary.spend, results),
    result,
    results,
    resultCoverage: resultCoverage(result, primary) ?? undefined,
    // Share of the allocation used up by the end of the period.
    budgetUtilisation: walletAllocation > 0 ? (costToDate / walletAllocation) * 100 : 0,
    avgDailySpend: campaignDays > 0 ? primary.spend / campaignDays : 0,
    avgDailyLeads: campaignDays > 0 ? primary.leads / campaignDays : 0,
    campaignDuration: campaignDays,
    remainingBudget: Math.max(0, budget - primary.spend),
    actualCost,
    gstAmount,
    remainingAllocation,
  }

  return {
    primary,
    comparison: comp,
    deltas,
    dailySeries,
    weeklySeries,
    derived,
    ...(reach?.period ? { periodReach: reach.period } : {}),
  }
}
