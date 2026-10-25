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

import sharp from 'sharp'
import { malayalamSummary } from './summary-language'
import { fetchReportData } from './data-engine'
import { buildKPIData } from './kpi-engine'
import { resolveTemplate } from './template-engine'
import { getBenchmarksWithSource } from '@/lib/advertising/ai/benchmarks'
import { todayISO } from '@/lib/utils/local-date'
import { generateForecast } from '@/lib/advertising/ai/forecasting'
import { assessCampaignHealth } from './campaign-health'
import { resolveBrandingUrl } from '@/lib/utils/branding'
import { buildAINarrative } from './ai-engine'
import type {
  ReportConfig, RenderData, BenchmarkSummary, ForecastBundle, HealthSummary, TemplateConfig,
  ReportRawData, CampaignBreakdownRow,
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
    projectIds: config.projectIds,
    clientId: config.clientId,
    dateFrom: config.dateFrom,
    dateTo: config.dateTo,
    comparisonFrom: config.comparisonFrom,
    comparisonTo: config.comparisonTo,
  })

  // ── 1b. Resolve agency logo to an embeddable data URI ────────────────────
  // Satori (image/PDF rasteriser) is most reliable with a data URI rather than
  // a remote URL. Convert the company logo once; store it on the brand so all
  // exporters reuse it.
  // Branding images can be stored as `storage:bucket/path` references, which
  // the rasteriser rejects ("Image source must be an absolute URL") — that
  // failed EVERY PDF and image export while Excel/CSV still worked. Resolve
  // them like the rest of the app does, embed them, and drop any image that
  // cannot be fetched rather than fail the whole export.
  const brand = { ...raw.branding }
  const logoSrc = brand.agencyLogoUrl ? resolveBrandingUrl(brand.agencyLogoUrl) : ''
  brand.agencyLogoUrl = logoSrc && /^https?:\/\//.test(logoSrc) ? await logoToDataUrl(logoSrc) : embeddable(logoSrc)
  const [bgTop, bgBottom] = await Promise.all([
    embedBackground(brand.bgImageTopUrl),
    embedBackground(brand.bgImageBottomUrl),
  ])
  brand.bgImageTopUrl = bgTop
  brand.bgImageBottomUrl = bgBottom

  // ── 2. Template config ───────────────────────────────────────────────────
  // Merge any per-section overrides the user supplied in ReportConfig.sections
  const baseTemplate = resolveTemplate(config.template)
  const template: TemplateConfig = config.sections
    ? { ...baseTemplate, sections: { ...baseTemplate.sections, ...config.sections } }
    : baseTemplate

  // ── 3. KPI data ──────────────────────────────────────────────────────────
  const kpi = buildKPIData(raw.metrics, raw.comparisonMetrics, raw.project, {
    period: raw.periodReach,
    comparison: raw.comparisonPeriodReach,
  })

  // ── 4. Benchmarks ────────────────────────────────────────────────────────
  const bm = await getBenchmarksWithSource(
    config.projectId,
    config.clientId,
    raw.project.campaignType ?? 'general',
  )
  // Placeholder ('global') benchmarks are shown with their real label but never
  // compared or graded against; every comparison also needs the metric to
  // exist (no CPL comparison with zero leads).
  const usable = bm.source !== 'global'
  const bmRaw = bm.metrics
  const vs = (value: number, bench: number, available: boolean) =>
    usable && available && bench > 0 ? ((value - bench) / bench) * 100 : 0
  const p0 = kpi.primary
  const benchmarks: BenchmarkSummary = {
    metrics: bmRaw,
    source: bm.source,
    roasVsBenchmark: vs(p0.roas, bmRaw.roas, p0.revenue > 0),
    ctrVsBenchmark:  vs(p0.ctr, bmRaw.ctr, p0.impressions > 0),
    cpcVsBenchmark:  vs(p0.cpc, bmRaw.cpc, p0.clicks > 0),
    cplVsBenchmark:  vs(p0.cpl, bmRaw.cpa, p0.leads > 0),
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

  // ── 6. Health score (shared rules — campaign-health.ts) ─────────────────
  const healthResult = assessCampaignHealth({
    spend:          kpi.primary.spend,
    revenue:        kpi.primary.revenue,
    roas:           kpi.primary.roas,
    ctr:            kpi.primary.ctr,
    cpc:            kpi.primary.cpc,
    conversionRate: kpi.derived.conversionRate,
    results:        kpi.derived.results ?? null,
    costPerResult:  kpi.derived.costPerResult,
    budget:         raw.project.adBudget,
    campaignStart:  raw.project.startDate,
    campaignEnd:    raw.project.endDate,
    periodFrom:     config.dateFrom,
    periodTo:       config.dateTo,
    today:          todayISO(),
    benchmarks:     bmRaw,
    benchmarkSource: bm.source,
    forecasts:      { roas: forecasts.roas30d, spend: forecasts.spend30d },
  })

  const health: HealthSummary = {
    result:  healthResult,
    grade:   healthResult.grade,
    risk:    healthResult.risk,
    score:   healthResult.score,
    verdict: healthResult.insufficientData
      ? 'Not enough data to grade yet'
      : gradeVerdict(healthResult.grade, healthResult.score),
  }

  const campaigns = raw.campaigns && raw.campaigns.length > 1 ? campaignBreakdown(raw.campaigns) : undefined

  // ── 7. AI Narrative ──────────────────────────────────────────────────────
  const ai = await buildAINarrative({
    config,
    template,
    kpi,
    benchmarks,
    forecasts,
    health,
    project: raw.project,
    dataQuality: raw.dataQuality,
    campaigns,
  })

  if (config.language === 'ml') ai.executiveSummary = malayalamSummary({ config, project: raw.project, kpi, campaigns })
  if (config.summaryOverride) ai.executiveSummary = config.summaryOverride

  return {
    config,
    template,
    brand,
    project: raw.project,
    kpi,
    benchmarks,
    forecasts,
    health,
    ai,
    ...(raw.dataQuality ? { dataQuality: raw.dataQuality } : {}),
    ...(campaigns ? { campaigns } : {}),
    generatedAt: new Date().toISOString(),
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Per-campaign lines for a client report, each under its own objective. */
function campaignBreakdown(campaigns: NonNullable<ReportRawData['campaigns']>): CampaignBreakdownRow[] {
  return campaigns.map(({ project, metrics }) => {
    const k = buildKPIData(metrics, [], project)
    const def = k.derived.result
    return {
      projectId: project.id,
      campaignName: project.campaignName,
      objective: project.campaignType,
      resultLabel: def?.metric ? def.label : null,
      costLabel: def?.metric ? def.costLabel : null,
      results: def?.metric ? k.derived.results ?? null : null,
      costPerResult: def?.metric ? k.derived.costPerResult : null,
      spend: k.primary.spend,
      impressions: k.primary.impressions,
      clicks: k.primary.clicks,
    }
  })
}

/**
 * Fetches a remote logo and returns a resized PNG data URI (or null on failure).
 * Mirrors the payslip renderer so report branding is consistent and never
 * depends on a live network fetch at raster time.
 */
/** A src the rasteriser accepts as-is (data URI), else null. */
function embeddable(src: string | null | undefined): string | null {
  return src && src.startsWith('data:image/') ? src : null
}

/** Resolve + embed a full-width page background; null when unavailable. */
async function embedBackground(value: string | null | undefined): Promise<string | null> {
  const src = value ? resolveBrandingUrl(value) : ''
  if (!src) return null
  if (!/^https?:\/\//.test(src)) return embeddable(src)
  try {
    const res = await fetch(src)
    if (!res.ok) return null
    const png = await sharp(Buffer.from(await res.arrayBuffer()))
      .resize({ width: 1600, withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer()
    return 'data:image/png;base64,' + png.toString('base64')
  } catch {
    return null
  }
}

async function logoToDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const raw = Buffer.from(await res.arrayBuffer())
    const png = await sharp(raw)
      .resize({ width: 480, height: 160, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer()
    return 'data:image/png;base64,' + png.toString('base64')
  } catch {
    return null
  }
}

function gradeVerdict(grade: string, score: number): string {
  if (grade === 'A') return `Excellent campaign — score ${score}/100`
  if (grade === 'B') return `Good campaign — score ${score}/100`
  if (grade === 'C') return `Average campaign — score ${score}/100`
  if (grade === 'D') return `Below-average — score ${score}/100`
  return `Needs attention — score ${score}/100`
}
