/**
 * Render Engine
 *
 * Assembles all layers — Data, KPI, Branding, Template, Benchmark,
 * Forecast, Health, AI — into the single RenderData payload that all
 * exporters (PDF, Excel, CSV, Image) consume.
 *
 * RenderData is serialised and stored in ad_reports.render_data so that
 * re-exporting any format never re-fetches the database or re-calls AI.
 */

import { fetchReportData } from './data-engine'
import { buildKPIData } from './kpi-engine'
import { resolveTemplate } from './template-engine'
import { getBenchmarks } from '@/lib/advertising/ai/benchmarks'
import { generateForecast } from '@/lib/advertising/ai/forecasting'
import { calculateWeightedHealthScore } from '@/lib/advertising/ai/scoring'
import { buildAINarrative } from './ai-engine'
import type {
  ReportConfig, RenderData, BenchmarkSummary, ForecastBundle, HealthSummary, TemplateConfig,
} from './types'

/**
 * Builds the complete RenderData for a report.
 * This is the most expensive function — it fetches DB data and calls AI.
 * The result is cached in ad_reports.render_data.
 */
export async function buildRenderData(config: ReportConfig): Promise<RenderData> {
  const t0 = Date.now()

  // ── 1. Raw data (DB fetch) ───────────────────────────────────────────────
  const raw = await fetchReportData({
    projectId: config.projectId,
    clientId: config.clientId,
    dateFrom: config.dateFrom,
    dateTo: config.dateTo,
    comparisonFrom: config.comparisonFrom,
    comparisonTo: config.comparisonTo,
  })

  // ── 2. Template config ───────────────────────────────────────────────────
  // Merge any per-section overrides the user supplied in ReportConfig.sections
  const baseTemplate = resolveTemplate(config.template)
  const template: TemplateConfig = config.sections
    ? { ...baseTemplate, sections: { ...baseTemplate.sections, ...config.sections } }
    : baseTemplate

  // ── 3. KPI data ──────────────────────────────────────────────────────────
  const kpi = buildKPIData(raw.metrics, raw.comparisonMetrics, raw.project)

  // ── 4. Benchmarks ────────────────────────────────────────────────────────
  const bmRaw = await getBenchmarks(
    config.projectId,
    config.clientId,
    raw.project.campaignType ?? 'general',
  )
  const benchmarks: BenchmarkSummary = {
    metrics: bmRaw,
    source: 'agency',       // getBenchmarks already applies the fallback chain
    roasVsBenchmark: bmRaw.roas > 0
      ? ((kpi.primary.roas - bmRaw.roas) / bmRaw.roas) * 100
      : 0,
    ctrVsBenchmark: bmRaw.ctr > 0
      ? ((kpi.primary.ctr - bmRaw.ctr) / bmRaw.ctr) * 100
      : 0,
    cpcVsBenchmark: bmRaw.cpc > 0
      ? ((kpi.primary.cpc - bmRaw.cpc) / bmRaw.cpc) * 100
      : 0,
    cplVsBenchmark: bmRaw.cpa > 0
      ? ((kpi.primary.cpl - bmRaw.cpa) / bmRaw.cpa) * 100
      : 0,
  }

  // ── 5. Forecasts ─────────────────────────────────────────────────────────
  const spendPoints = raw.metrics.map(m => ({ date: m.date, value: m.spend }))
  const leadsPoints = raw.metrics.map(m => ({ date: m.date, value: m.leads }))
  const roasPoints  = raw.metrics.map(m => ({
    date: m.date,
    value: m.spend > 0 ? m.revenue / m.spend : 0,
  }))

  const forecasts: ForecastBundle = {
    spend7d:  generateForecast(spendPoints, 7),
    spend30d: generateForecast(spendPoints, 30),
    spend90d: generateForecast(spendPoints, 90),
    leads7d:  generateForecast(leadsPoints, 7),
    leads30d: generateForecast(leadsPoints, 30),
    roas30d:  generateForecast(roasPoints, 30),
  }

  // ── 6. Health score ──────────────────────────────────────────────────────
  const healthResult = calculateWeightedHealthScore(
    {
      spend:           kpi.primary.spend,
      budget:          raw.project.adBudget,
      roas:            kpi.primary.roas,
      ctr:             kpi.primary.ctr,
      cpc:             kpi.primary.cpc,
      cpa:             kpi.primary.cpa,
      conversion_rate: kpi.derived.conversionRate,
    },
    bmRaw,
    { roas: forecasts.roas30d, spend: forecasts.spend30d },
  )

  const health: HealthSummary = {
    result:  healthResult,
    grade:   healthResult.grade,
    risk:    healthResult.risk,
    score:   healthResult.score,
    verdict: gradeVerdict(healthResult.grade, healthResult.score),
  }

  // ── 7. AI Narrative ──────────────────────────────────────────────────────
  const ai = await buildAINarrative({
    config,
    template,
    kpi,
    benchmarks,
    forecasts,
    health,
    project: raw.project,
  })

  return {
    config,
    template,
    brand: raw.branding,
    project: raw.project,
    kpi,
    benchmarks,
    forecasts,
    health,
    ai,
    generatedAt: new Date().toISOString(),
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function gradeVerdict(grade: string, score: number): string {
  if (grade === 'A') return `Excellent campaign — score ${score}/100`
  if (grade === 'B') return `Good campaign — score ${score}/100`
  if (grade === 'C') return `Average campaign — score ${score}/100`
  if (grade === 'D') return `Below-average — score ${score}/100`
  return `Needs attention — score ${score}/100`
}
