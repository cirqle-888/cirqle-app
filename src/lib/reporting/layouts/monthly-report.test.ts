/**
 * Unit tests for `computeMonthlyRows` (Monthly Report's day→month rollup).
 *
 * Run with:  npx vitest run src/lib/reporting/layouts/monthly-report.test.ts
 *
 * The fixture deliberately uses varying day-to-day ROAS/CTR within each
 * month so that "ratio of the month's summed totals" and "average of the
 * daily ratios" would disagree if the implementation got this wrong — e.g.
 * June's two days have ROAS 3.0 and 1.0 (average 2.0), but the correct
 * ratio-of-sums answer is 500/300 = 1.6667, matching how `aggregateMetrics`
 * in lib/advertising/reporting.ts treats these metrics everywhere else in
 * the app (averaging daily ratios would double-count low-spend days).
 */
import { describe, it, expect } from 'vitest'
import { computeMonthlyRows } from './monthly-report'
import type { RenderData, DailySeriesPoint } from '../types'

function day(date: string, opts: { spend: number; revenue: number; impressions: number; clicks: number; reach: number; leads: number }): DailySeriesPoint {
  return {
    date, spend: opts.spend, revenue: opts.revenue, impressions: opts.impressions,
    clicks: opts.clicks, reach: opts.reach, leads: opts.leads,
    // Daily-level ratio fields are irrelevant to computeMonthlyRows — it
    // recomputes roas/ctr/cpr from the month's summed totals, never from
    // these per-day values — so placeholders are fine here.
    roas: 0, ctr: 0, cpr: 0, actualCost: 0, gstAmount: 0, remainingAllocation: 0,
  }
}

function fixture(dailySeries: DailySeriesPoint[], walletAllocation: number): RenderData {
  return {
    config: { projectId: 'p1', clientId: 'c1', reportType: 'custom', template: 'monthly', dateFrom: '2026-06-01', dateTo: '2026-07-31', formats: ['pdf'] },
    template: {
      name: 'monthly', displayName: 'Monthly Report', primaryKPI: 'reach',
      sections: { executiveSummary: false, kpiScorecard: true, dailyBreakdown: true, campaignHealth: false, benchmarkComparison: false, forecast: false, aiInsights: false, budgetAnalysis: true, recommendations: false },
    },
    brand: {
      agencyName: 'Cirqle', clientName: 'Acme', primaryColor: '#000', secondaryColor: '#000', accentColor: '#000',
      logoUrl: null, agencyLogoUrl: null, contactPhone: null, contactEmail: null, contactWebsite: null, footerText: null,
      whiteLabelMode: 'cirqle', confidentialWatermark: false, showPoweredBy: true,
    },
    project: {
      id: 'p1', clientId: 'c1', clientName: 'Acme', clientCode: 'ACM', campaignName: 'Test Campaign',
      platform: 'meta', campaignType: null, status: 'active', adBudget: 5000, adBudgetCurrency: 'INR',
      serviceChargeType: 'percent', serviceChargeValue: 30, taxPercent: 0, budgetInputMode: 'total',
      dailyBudgetConfigured: null, budgetDaysConfigured: null, objective: null,
      startDate: dailySeries[0]?.date ?? null, endDate: dailySeries[dailySeries.length - 1]?.date ?? null,
      walletAllocation,
    },
    kpi: {
      primary: { spend: 0, revenue: 0, impressions: 0, clicks: 0, reach: 0, leads: 0, conversions: 0, days: 0, roas: 0, ctr: 0, cpc: 0, cpm: 0, cpl: 0, cpa: 0 },
      dailySeries, weeklySeries: [],
      derived: { profit: 0, margin: 0, roi: 0, conversionRate: 0, costPerResult: 0, budgetUtilisation: 0, avgDailySpend: 0, avgDailyLeads: 0, campaignDuration: 0, remainingBudget: 0, actualCost: 0, gstAmount: 0, remainingAllocation: 0 },
    },
    benchmarks: { metrics: { roas: 0, cpc: 0, ctr: 0, cpa: 0, cpm: 0, conversion_rate: 0, margin: 0 }, source: 'global', roasVsBenchmark: 0, ctrVsBenchmark: 0, cpcVsBenchmark: 0, cplVsBenchmark: 0 },
    forecasts: {
      spend7d: { metric: 'spend', predicted_value: 0, confidence: 0, trend: 'flat', model_used: 'linear' },
      spend30d: { metric: 'spend', predicted_value: 0, confidence: 0, trend: 'flat', model_used: 'linear' },
      spend90d: { metric: 'spend', predicted_value: 0, confidence: 0, trend: 'flat', model_used: 'linear' },
      leads7d: { metric: 'leads', predicted_value: 0, confidence: 0, trend: 'flat', model_used: 'linear' },
      leads30d: { metric: 'leads', predicted_value: 0, confidence: 0, trend: 'flat', model_used: 'linear' },
      roas30d: { metric: 'roas', predicted_value: 0, confidence: 0, trend: 'flat', model_used: 'linear' },
    },
    health: { result: { score: 0, grade: 'C', risk: 'low', confidence: 0, explanations: [], components: { budgetScore: 0, performanceScore: 0, benchmarkScore: 0, forecastScore: 0 } }, grade: 'C', risk: 'low', score: 0, verdict: '' },
    ai: { executiveSummary: '', keyInsights: [], risks: [], opportunities: [], recommendedActions: [], budgetRecommendations: '', generatedAt: '2026-07-14T00:00:00Z' },
    generatedAt: '2026-07-14T00:00:00Z',
  }
}

describe('computeMonthlyRows', () => {
  it('groups daily rows by calendar month and recomputes ratios as ratio-of-sums, not average-of-ratios', () => {
    const data = fixture([
      day('2026-06-28', { spend: 100, revenue: 300, impressions: 1000, clicks: 100, reach: 900,  leads: 10 }), // daily ROAS 3.0
      day('2026-06-29', { spend: 200, revenue: 200, impressions: 2000, clicks: 100, reach: 1800, leads: 5 }),  // daily ROAS 1.0
      day('2026-07-01', { spend: 50,  revenue: 250, impressions: 500,  clicks: 25,  reach: 450,  leads: 3 }),
      day('2026-07-02', { spend: 150, revenue: 150, impressions: 1500, clicks: 75,  reach: 1350, leads: 8 }),
    ], 10000)

    const rows = computeMonthlyRows(data)
    expect(rows).toHaveLength(2)

    const [june, july] = rows
    expect(june.date).toBe('2026-06')
    expect(june.monthLabel).toBe('Jun 2026')
    expect(june.days).toBe(2)
    expect(june.spend).toBe(300)
    expect(june.revenue).toBe(500)
    expect(june.reach).toBe(2700)
    expect(june.impressions).toBe(3000)
    expect(june.clicks).toBe(200)
    expect(june.leads).toBe(15)
    // Ratio-of-sums: 500/300 = 1.6667 — NOT the average of 3.0 and 1.0 (2.0).
    expect(june.roas).toBeCloseTo(500 / 300, 6)
    expect(june.roas).not.toBeCloseTo(2.0, 1)
    expect(june.ctr).toBeCloseTo((200 / 3000) * 100, 6)
    expect(june.cpr).toBeCloseTo(300 / 15, 6)
    // GST 18% on spend, accumulated in chronological order.
    expect(june.gstAmount).toBeCloseTo(300 * 0.18, 6)
    expect(june.actualCost).toBeCloseTo(300 * 1.18, 6)
    // Terminal balance = last day in the month's running balance, not summed.
    // day1 actualCost=118 → balance 9882; day2 actualCost=236 → cumulative 354 → balance 9646.
    expect(june.balance).toBeCloseTo(10000 - 354, 6)

    expect(july.date).toBe('2026-07')
    expect(july.monthLabel).toBe('Jul 2026')
    expect(july.days).toBe(2)
    expect(july.spend).toBe(200)
    expect(july.revenue).toBe(400)
    expect(july.roas).toBeCloseTo(400 / 200, 6)
    expect(july.ctr).toBeCloseTo((100 / 2000) * 100, 6)
    // day3 actualCost=59 → cumulative 354+59=413; day4 actualCost=177 → cumulative 590 → balance 9410.
    expect(july.balance).toBeCloseTo(10000 - 590, 6)
  })

  it('returns an empty array for a campaign with no daily metrics', () => {
    const data = fixture([], 10000)
    expect(computeMonthlyRows(data)).toEqual([])
  })

  it('handles a single day (one-row month)', () => {
    const data = fixture([
      day('2026-07-05', { spend: 100, revenue: 0, impressions: 500, clicks: 10, reach: 400, leads: 0 }),
    ], 1000)
    const rows = computeMonthlyRows(data)
    expect(rows).toHaveLength(1)
    expect(rows[0].date).toBe('2026-07')
    expect(rows[0].days).toBe(1)
    // No revenue → ROAS 0 (not NaN/Infinity from a spend>0 divide-by-zero-revenue).
    expect(rows[0].roas).toBe(0)
    // No leads → falls back to clicks for CPR's denominator.
    expect(rows[0].cpr).toBeCloseTo(100 / 10, 6)
  })
})
