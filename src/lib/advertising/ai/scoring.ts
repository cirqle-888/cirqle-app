/**
 * Weighted Health Score Engine
 *
 * Generates an explainable health score based on weighted components.
 *
 * A component that cannot be judged is LEFT OUT of the weighted average,
 * rather than scored low. Before, a lead or awareness campaign with no sales
 * tracking had ROAS 0, which scored "Critical absolute ROAS" plus "ROAS below
 * benchmark" — 60% of the weight — so almost every such campaign graded D/F.
 * Now ROAS (and the ROAS forecast) only count when revenue is tracked;
 * otherwise performance is judged on cost per result / CTR against a REAL
 * benchmark, and pacing compares spend with what should have been spent by
 * now (`expectedSpend`) rather than with the whole budget.
 */

// Type-only: this module also runs in the browser (campaign page), and
// benchmarks.ts pulls in the server-only Supabase client.
import type { BenchmarkMetrics } from './benchmarks'
import type { ForecastResult } from './forecasting'

export interface CampaignMetrics {
  spend: number
  budget: number
  roas: number
  ctr: number
  cpc: number
  cpa: number
  conversion_rate: number
  /** True when the platform reports revenue for this campaign. Defaults to
   *  `roas > 0` for older callers. */
  revenueTracked?: boolean
  /** Spend expected by the end of the period given elapsed campaign time.
   *  When given, pacing is spend ÷ expectedSpend; when null, pacing is not
   *  assessed (no campaign dates). Omitted = old behaviour (spend ÷ budget). */
  expectedSpend?: number | null
  /** Results the cost-per-result was computed from (null = no result metric). */
  results?: number | null
}

export interface HealthScoreResult {
  score: number
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  risk: 'low' | 'medium' | 'high' | 'critical'
  confidence: number
  explanations: string[]
  /** True when performance could not be judged — pacing alone is not a
   *  campaign grade, so the grade carries no signal. */
  insufficientData?: boolean
  components: {
    budgetScore: number
    performanceScore: number
    benchmarkScore: number
    forecastScore: number
  }
}

export function calculateWeightedHealthScore(
  metrics: CampaignMetrics,
  benchmarks: BenchmarkMetrics,
  forecasts?: { roas?: ForecastResult; spend?: ForecastResult },
  weights: any = { budget: 20, performance: 40, benchmark: 20, forecast: 20 }
): HealthScoreResult {
  const explanations: string[] = []
  // null = not assessed (excluded from the weighted average)
  let budgetScore: number | null = null
  let performanceScore: number | null = null
  let benchmarkScore: number | null = null
  let forecastScore: number | null = null
  let confidence = 70 // Base confidence
  const revenueTracked = metrics.revenueTracked ?? metrics.roas > 0

  // ── Pacing ──
  const pacingBase = metrics.expectedSpend === undefined ? metrics.budget : metrics.expectedSpend
  if (pacingBase != null && pacingBase > 0) {
    const pacing = metrics.spend / pacingBase
    const what = metrics.expectedSpend === undefined ? 'of budget' : 'of expected spend to date'
    if (pacing >= 0.8 && pacing <= 1.05) {
      budgetScore = 100
      explanations.push(`Budget pacing is on track (80-105% ${what}).`)
    } else if (pacing > 1.2) {
      budgetScore = 20
      explanations.push(`Severe overspending detected (>120% ${what}).`)
      confidence += 10
    } else if (pacing < 0.5) {
      budgetScore = 30
      explanations.push(`Severe underspending detected (<50% ${what}).`)
    } else {
      budgetScore = 70
    }
  } else {
    explanations.push(metrics.expectedSpend === null
      ? 'No campaign dates or budget; pacing not assessed.'
      : 'No budget defined; pacing not assessed.')
    confidence -= 10
  }

  // ── Performance ──
  if (revenueTracked) {
    if (metrics.roas > 2.0) {
      performanceScore = 90
      explanations.push('Strong absolute ROAS (>2.0).')
    } else if (metrics.roas < 0.5) {
      performanceScore = 20
      explanations.push('Critical absolute ROAS (<0.5).')
    } else {
      performanceScore = 60
    }
  } else if (metrics.results != null && metrics.results > 0 && benchmarks.cpa > 0 && metrics.cpa > 0) {
    const ratio = metrics.cpa / benchmarks.cpa // lower is better
    performanceScore = ratio < 0.8 ? 90 : ratio > 1.25 ? 30 : 65
    explanations.push(`Cost per result is ${ratio <= 1 ? Math.round((1 - ratio) * 100) + '% below' : Math.round((ratio - 1) * 100) + '% above'} benchmark.`)
  } else if (metrics.ctr > 0 && benchmarks.ctr > 0) {
    const ratio = metrics.ctr / benchmarks.ctr
    performanceScore = ratio > 1.2 ? 90 : ratio < 0.8 ? 35 : 65
    explanations.push(`CTR is ${Math.round(Math.abs(ratio - 1) * 100)}% ${ratio >= 1 ? 'above' : 'below'} benchmark.`)
  } else {
    explanations.push('Sales revenue is not tracked and no comparable benchmark exists; performance not graded.')
  }

  // ── Benchmark ──
  if (revenueTracked && benchmarks.roas > 0) {
    const roasRatio = metrics.roas / benchmarks.roas
    if (roasRatio > 1.2) {
      benchmarkScore = 100
      explanations.push(`ROAS is ${Math.round((roasRatio-1)*100)}% above benchmark.`)
    } else if (roasRatio < 0.8) {
      benchmarkScore = 20
      explanations.push(`ROAS is ${Math.round((1-roasRatio)*100)}% below benchmark.`)
    } else {
      benchmarkScore = 75
    }
  } else if (!revenueTracked && metrics.cpc > 0 && benchmarks.cpc > 0) {
    const ratio = metrics.cpc / benchmarks.cpc
    benchmarkScore = ratio < 0.8 ? 100 : ratio > 1.25 ? 25 : 75
  } else {
    confidence -= 20
    explanations.push('No comparable benchmark; benchmark not scored.')
  }

  // ── Forecast (ROAS trend — meaningless without revenue) ──
  if (revenueTracked && forecasts?.roas) {
    if (forecasts.roas.trend === 'up') {
      forecastScore = 90
      explanations.push('Forecast predicts upward ROAS trend.')
    } else if (forecasts.roas.trend === 'down') {
      forecastScore = 30
      explanations.push('Forecast predicts downward ROAS trend.')
    } else {
      forecastScore = 60
    }
    confidence = Math.min(100, (confidence + forecasts.roas.confidence) / 2)
  }

  const parts: [number | null, number][] = [
    [budgetScore, weights.budget],
    [performanceScore, weights.performance],
    [benchmarkScore, weights.benchmark],
    [forecastScore, weights.forecast],
  ]
  const judged = parts.filter((p): p is [number, number] => p[0] != null)
  const totalWeight = judged.reduce((t, [, w]) => t + w, 0)
  // A campaign on pace with no measurable results is not an "A": without a
  // performance signal the grade is withheld (pacing is still explained).
  const insufficientData = totalWeight === 0 || performanceScore == null
  const finalScore = totalWeight === 0 ? 50 : judged.reduce((t, [v, w]) => t + v * w, 0) / totalWeight
  if (insufficientData) {
    confidence = 0
    explanations.unshift('Not enough data to grade this campaign yet.')
  }

  const score = Math.round(Math.max(0, Math.min(100, finalScore)))

  let grade: HealthScoreResult['grade'] = 'F'
  if (score >= 90) grade = 'A'
  else if (score >= 80) grade = 'B'
  else if (score >= 70) grade = 'C'
  else if (score >= 60) grade = 'D'

  let risk: HealthScoreResult['risk'] = 'medium'
  if (score >= 80) risk = 'low'
  else if (score < 40) risk = 'critical'
  else if (score < 60) risk = 'high'

  return {
    score,
    grade,
    risk,
    confidence: Math.round(Math.max(0, confidence)),
    explanations,
    ...(insufficientData ? { insufficientData } : {}),
    // Components not assessed report a neutral 50 for display compatibility.
    components: {
      budgetScore: budgetScore ?? 50,
      performanceScore: performanceScore ?? 50,
      benchmarkScore: benchmarkScore ?? 50,
      forecastScore: forecastScore ?? 50,
    }
  }
}
