/**
 * Weighted Health Score Engine
 * 
 * Generates an explainable health score based on weighted components.
 */

import { BenchmarkMetrics } from './benchmarks'
import { ForecastResult } from './forecasting'

export interface CampaignMetrics {
  spend: number
  budget: number
  roas: number
  ctr: number
  cpc: number
  cpa: number
  conversion_rate: number
}

export interface HealthScoreResult {
  score: number
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  risk: 'low' | 'medium' | 'high' | 'critical'
  confidence: number
  explanations: string[]
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
  let budgetScore = 50, performanceScore = 50, benchmarkScore = 50, forecastScore = 50
  let confidence = 70 // Base confidence
  
  if (metrics.budget > 0) {
    const pacing = metrics.spend / metrics.budget
    if (pacing >= 0.8 && pacing <= 1.05) {
      budgetScore = 100
      explanations.push('Budget pacing is optimal (80-105%).')
    } else if (pacing > 1.2) {
      budgetScore = 20
      explanations.push('Severe overspending detected (>120% of budget).')
      confidence += 10
    } else if (pacing < 0.5) {
      budgetScore = 30
      explanations.push('Severe underspending detected (<50% of budget).')
    } else {
      budgetScore = 70
    }
  } else {
    explanations.push('No budget defined; budget score neutral.')
    confidence -= 10
  }

  if (metrics.roas > 2.0) {
    performanceScore = 90
    explanations.push('Strong absolute ROAS (>2.0).')
  } else if (metrics.roas < 0.5) {
    performanceScore = 20
    explanations.push('Critical absolute ROAS (<0.5).')
  } else {
    performanceScore = 60
  }

  if (benchmarks.roas > 0) {
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
  } else {
    confidence -= 20
    explanations.push('Missing benchmark data; benchmark score neutral.')
  }

  if (forecasts?.roas) {
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

  const totalWeight = weights.budget + weights.performance + weights.benchmark + weights.forecast
  const finalScore = (
    (budgetScore * weights.budget) +
    (performanceScore * weights.performance) +
    (benchmarkScore * weights.benchmark) +
    (forecastScore * weights.forecast)
  ) / totalWeight

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
    confidence: Math.round(confidence),
    explanations,
    components: { budgetScore, performanceScore, benchmarkScore, forecastScore }
  }
}
