/**
 * KPI Engine
 *
 * Wraps the existing aggregateMetrics() and aggregateByPeriod() from
 * src/lib/advertising/reporting.ts. Adds:
 *   • Comparison deltas
 *   • Daily + weekly series for charts
 *   • Derived KPIs (profit, margin, ROI, budget utilisation)
 *
 * All monetary values are in INR (base currency) — exchange-rate
 * conversion has already been applied by the Data Engine.
 */

import { aggregateMetrics, aggregateByPeriod } from '@/lib/advertising/reporting'
import { AD_SPEND_GST_RATE } from '@/lib/advertising/budget'
import type {
  KPIData, KPIDeltas, DailySeriesPoint, WeeklySeriesPoint, DerivedKPIs,
} from './types'
import type { ReportMetricRow, ReportProject } from './types'

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
      exchange_rate_ad_to_base: 1, // already converted
    }))

  const primaryAdRows = toAdRows(metrics)
  const compAdRows = toAdRows(comparison)

  // ── Primary aggregate ───────────────────────────────────────────────────
  const primary = aggregateMetrics(primaryAdRows)

  // ── Comparison aggregate ────────────────────────────────────────────────
  const comp = comparison.length > 0 ? aggregateMetrics(compAdRows) : undefined

  // ── Deltas ──────────────────────────────────────────────────────────────
  const deltas: KPIDeltas | undefined = comp
    ? {
        spendDelta:       pct(primary.spend, comp.spend),
        revenueDelta:     pct(primary.revenue, comp.revenue),
        impressionsDelta: pct(primary.impressions, comp.impressions),
        clicksDelta:      pct(primary.clicks, comp.clicks),
        reachDelta:       pct(primary.reach, comp.reach),
        leadsDelta:       pct(primary.leads, comp.leads),
        roasDelta:        pct(primary.roas, comp.roas),
        ctrDelta:         pct(primary.ctr, comp.ctr),
        cpcDelta:         pct(primary.cpc, comp.cpc),
        cpmDelta:         pct(primary.cpm, comp.cpm),
        cplDelta:         pct(primary.cpl, comp.cpl),
      }
    : undefined

  // ── Daily series ────────────────────────────────────────────────────────
  const dailyGroups = aggregateByPeriod(primaryAdRows, 'daily')
  const dailySeries: DailySeriesPoint[] = Object.entries(dailyGroups)
    .sort(([a], [b]) => b.localeCompare(a)) // Sort by date descending (newest first)
    .map(([date, agg]) => {
      const dayResults = agg.leads || agg.conversions || agg.clicks
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
        cpr: dayResults > 0 ? agg.spend / dayResults : 0,
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
      const weekResults = agg.leads || agg.conversions || agg.clicks
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
        cpr: weekResults > 0 ? agg.spend / weekResults : 0,
        actualCost: agg.spend * taxMultiplier,
        gstAmount: agg.spend * (taxMultiplier - 1),
        remainingAllocation: 0,
      }
    })

  // ── Derived KPIs ────────────────────────────────────────────────────────
  const profit = primary.revenue - primary.spend
  const budget = project.adBudget
  const walletAllocation = project.walletAllocation || 0
  const actualCost = primary.spend * taxMultiplier
  const gstAmount = primary.spend * (taxMultiplier - 1)
  const remainingAllocation = walletAllocation - actualCost
  const results = primary.leads || primary.conversions || primary.clicks
  const campaignDays = metrics.length

  const derived: DerivedKPIs = {
    profit,
    margin: primary.revenue > 0 ? (profit / primary.revenue) * 100 : 0,
    roi: primary.spend > 0 ? (profit / primary.spend) * 100 : 0,
    conversionRate: primary.clicks > 0 ? (primary.leads / primary.clicks) * 100 : 0,
    costPerResult: results > 0 ? primary.spend / results : 0,
    budgetUtilisation: walletAllocation > 0 ? (actualCost / walletAllocation) * 100 : 0,
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
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Signed percentage change from baseline to current. */
function pct(current: number, baseline: number): number {
  if (baseline === 0) return current > 0 ? 100 : 0
  return ((current - baseline) / baseline) * 100
}
