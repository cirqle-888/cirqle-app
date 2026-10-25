/**
 * Campaign health — ONE set of rules for reports and the campaign page.
 *
 * The campaign page used to score health with its own formula (ROAS 40%,
 * CTR 25%, pacing over the whole flight), so a lead or messaging campaign
 * with no sales tracking read "Poor" on the page while its report said it
 * could not be graded. Both now call this, which wraps the report scorer:
 * ROAS only counts when revenue is tracked, performance is judged on cost
 * per result / CTR against a real (non-placeholder) benchmark, pacing uses
 * time-aware expected spend, and no performance signal means "not graded".
 *
 * Pure and browser-safe: benchmarks are fetched by the caller.
 */

import { calculateWeightedHealthScore, type HealthScoreResult } from '@/lib/advertising/ai/scoring'
import type { BenchmarkMetrics } from '@/lib/advertising/ai/benchmarks'
import type { ForecastResult } from '@/lib/advertising/ai/forecasting'
import { expectedSpendForPeriod } from './pacing'

const NO_BENCHMARKS: BenchmarkMetrics = { roas: 0, cpc: 0, ctr: 0, cpa: 0, cpm: 0, conversion_rate: 0, margin: 0 }

export interface CampaignHealthInput {
  /** Ex-GST spend in base currency for the assessed period. */
  spend: number
  revenue: number
  roas: number
  ctr: number
  cpc: number
  conversionRate: number
  /** Objective results and spend ÷ results (null = unavailable). */
  results: number | null
  costPerResult: number | null
  budget: number
  campaignStart: string | null
  campaignEnd: string | null
  periodFrom: string
  periodTo: string
  /** Today on the business calendar (YYYY-MM-DD). */
  today: string
  benchmarks: BenchmarkMetrics | null
  /** 'global' = placeholder values: never graded against. */
  benchmarkSource: string | null
  forecasts?: { roas?: ForecastResult; spend?: ForecastResult }
}

export function assessCampaignHealth(i: CampaignHealthInput): HealthScoreResult {
  const usable = i.benchmarks && i.benchmarkSource && i.benchmarkSource !== 'global'
  return calculateWeightedHealthScore(
    {
      spend:           i.spend,
      budget:          i.budget,
      roas:            i.roas,
      ctr:             i.ctr,
      cpc:             i.cpc,
      cpa:             i.costPerResult ?? 0,
      conversion_rate: i.conversionRate,
      revenueTracked:  i.revenue > 0,
      results:         i.results,
      expectedSpend:   expectedSpendForPeriod({
        budget:        i.budget,
        campaignStart: i.campaignStart,
        campaignEnd:   i.campaignEnd,
        periodFrom:    i.periodFrom,
        periodTo:      i.periodTo,
        today:         i.today,
      }),
    },
    usable ? i.benchmarks! : NO_BENCHMARKS,
    i.forecasts,
  )
}

/** Short label for a health result: "Grade B · 82/100" or "Not graded". */
export function healthLabel(h: HealthScoreResult): string {
  return h.insufficientData ? 'Not graded' : `Grade ${h.grade} · ${h.score}/100`
}
