/**
 * Forecast engine (Phase 4) — READ ONLY, no new schema.
 *
 * This does NOT invent business numbers. It extrapolates the series the trend
 * engine already produced (loadRetainerAnalyticsTrend) with a simple least-
 * squares linear projection, and derives a confidence band from the fit. Every
 * input value comes from the existing analytics/trend engines.
 */

import type { RetainerTrendPoint } from './analytics'

export type Confidence = 'high' | 'medium' | 'low'

export interface RetainerForecast {
  basisMonths: number            // points of real data used
  confidence: Confidence
  // Money forecasts are null when pricingVisible = false.
  nextMonthRevenue: number | null
  quarterRevenue: number | null  // next 3 months
  annualRevenue: number | null   // next 12 months
  nextMonthInternalCost: number | null
  nextMonthMargin: number | null
  nextMonthProfit: number | null
  // Always available (not money):
  expectedUtilisation: number | null
  expectedDelivered: number | null
}

/** Least-squares slope/intercept over y indexed 0..n-1; predict at x. */
function linreg(y: number[]): { predict: (x: number) => number; r2: number } {
  const n = y.length
  if (n === 0) return { predict: () => 0, r2: 0 }
  if (n === 1) return { predict: () => y[0], r2: 1 }
  const xs = y.map((_, i) => i)
  const mx = (n - 1) / 2
  const my = y.reduce((s, v) => s + v, 0) / n
  let num = 0, den = 0
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (y[i] - my); den += (xs[i] - mx) ** 2 }
  const slope = den === 0 ? 0 : num / den
  const intercept = my - slope * mx
  // R² for confidence.
  let ssTot = 0, ssRes = 0
  for (let i = 0; i < n; i++) { const f = intercept + slope * i; ssTot += (y[i] - my) ** 2; ssRes += (y[i] - f) ** 2 }
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot)
  return { predict: (x: number) => intercept + slope * x, r2 }
}

const clamp0 = (n: number) => Math.max(0, Math.round(n))

/**
 * Forecast from a trend series. Uses only months that carry real signal
 * (revenue or committed deliverables) so leading empty months don't drag the
 * projection to zero.
 */
export function forecastFromTrend(trend: RetainerTrendPoint[], pricingVisible: boolean): RetainerForecast {
  const pts = trend.filter(t => t.included > 0 || (t.revenue ?? 0) > 0)
  const n = pts.length
  const next = n // predict the point just after the last

  const project = (vals: (number | null)[]): number | null => {
    const ys = vals.map(v => v ?? 0)
    if (ys.length === 0) return null
    if (ys.length === 1) return ys[0]
    return linreg(ys).predict(next)
  }

  // Confidence: needs enough points AND a reasonable fit on utilisation
  // (the most stable series). Falls back sensibly with sparse data.
  let confidence: Confidence = 'low'
  if (n >= 4) {
    const r2 = linreg(pts.map(p => p.avgUtilisation)).r2
    confidence = r2 >= 0.6 ? 'high' : 'medium'
  } else if (n >= 2) {
    confidence = 'medium'
  }

  const revNext = pricingVisible ? project(pts.map(p => p.revenue)) : null
  const costNext = pricingVisible ? project(pts.map(p => p.internalCost)) : null
  const util = project(pts.map(p => p.avgUtilisation))
  const delivered = project(pts.map(p => p.delivered))
  const marginNext = revNext != null && costNext != null ? Math.round(revNext - costNext) : null

  return {
    basisMonths: n,
    confidence,
    nextMonthRevenue: revNext != null ? clamp0(revNext) : null,
    quarterRevenue: revNext != null ? clamp0(revNext) * 3 : null,
    annualRevenue: revNext != null ? clamp0(revNext) * 12 : null,
    nextMonthInternalCost: costNext != null ? clamp0(costNext) : null,
    nextMonthMargin: marginNext,
    nextMonthProfit: marginNext,
    expectedUtilisation: util != null ? Math.max(0, Math.round(util)) : null,
    expectedDelivered: delivered != null ? clamp0(delivered) : null,
  }
}
