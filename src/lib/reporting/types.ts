/**
 * Reporting System v2 — Shared Types
 *
 * Provider-agnostic. All engines, exporters, and templates depend only on
 * these interfaces — never on Supabase row types directly.
 *
 * Conventions:
 *   • Monetary values are always in INR (base currency) unless noted.
 *   • Dates are always ISO-8601 strings (YYYY-MM-DD).
 *   • Optional fields are undefined (not null) for easier spreads.
 */

import type { AggregateMetrics } from '@/lib/advertising/reporting'
import type { ForecastResult } from '@/lib/advertising/ai/forecasting'
import type { HealthScoreResult } from '@/lib/advertising/ai/scoring'
import type { BenchmarkMetrics } from '@/lib/advertising/ai/benchmarks'
import type { ResultDefinition } from './result-type'
import type { DataQuality } from './data-quality'
import type { PeriodReach } from '@/lib/advertising/period-reach'

// ─── Report Config ────────────────────────────────────────────────────────────

export type ReportType = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'custom'
export type ReportTemplate = 'executive' | 'marketing' | 'lead_gen' | 'ecommerce' | 'performance' | 'agency' | 'daily' | 'monthly'
export type ReportFormat = 'pdf' | 'xlsx' | 'csv' | 'image_portrait' | 'image_square' | 'image_bundle'
export type WhiteLabelMode = 'cirqle' | 'client' | 'agency'
export type ReportStatus = 'pending' | 'generating' | 'partial' | 'ready' | 'failed'

export interface ReportConfig {
  snapshotId?: string
  supersedesId?: string
  allowIncomplete?: boolean
  language?: 'en' | 'ml'
  summaryOverride?: string
  /** Internal stable identity; never accepted from an untrusted request. */
  reportId?: string
  /** The report's primary campaign (the first of projectIds for a client report). */
  projectId: string
  /**
   * Client report: every campaign included (2+ ids, all the same client).
   * Absent / one id = a single-campaign report. Snapshotted in the config so
   * later campaign changes never alter an old report.
   */
  projectIds?: string[]
  clientId: string
  reportType: ReportType
  template: ReportTemplate
  dateFrom: string        // YYYY-MM-DD
  dateTo: string          // YYYY-MM-DD
  comparisonFrom?: string // YYYY-MM-DD
  comparisonTo?: string   // YYYY-MM-DD
  formats: ReportFormat[]
  /**
   * Optional per-section overrides. Keys present here take precedence over
   * the template's default sections. Lets users toggle individual sections
   * from the UI without changing the base template.
   */
  sections?: Partial<TemplateSections>
  /** UUID of employee triggering the report. */
  generatedBy?: string
  /** UUID of linked schedule (if automated). */
  scheduleId?: string
  /** Recipients for email delivery. */
  recipients?: ReportRecipient[]
}

export interface ReportRecipient {
  email: string
  name?: string
  language?: string
}

// ─── Raw Data (output of Data Engine) ────────────────────────────────────────

export interface ReportProject {
  id: string
  clientId: string
  clientName: string
  clientCode: string
  campaignName: string
  platform: string
  campaignType: string | null
  status: string
  adBudget: number
  adBudgetCurrency: string
  serviceChargeType: string
  serviceChargeValue: number
  taxPercent: number
  /** 'total' (lump-sum adBudget) or 'daily' (dailyBudgetConfigured × budgetDaysConfigured). */
  budgetInputMode: string
  /** Raw per-day ad spend rate as configured on the Budget tab (mode === 'daily'). */
  dailyBudgetConfigured: number | null
  /** Configured duration in days (mode === 'daily'), matching the Budget tab's "Duration". */
  budgetDaysConfigured: number | null
  objective: string | null
  startDate: string | null
  endDate: string | null
  /** Campaign allocations from ad_wallet_ledger made on or before the
   *  report's end date (GST-inclusive INR). */
  walletAllocation: number
  /** Ad spend (ex-GST, base currency) before the report's start date. */
  priorSpend?: number
  /**
   * Allocation remaining when the period opened: walletAllocation minus the
   * GST-inclusive cost of priorSpend. Running and closing balances in the
   * report are this minus in-period cost. Absent on snapshots made before it
   * existed — readers fall back to walletAllocation (the old behaviour).
   */
  openingBalance?: number
}

export interface ReportMetricRow {
  date: string
  spend: number
  revenue: number
  impressions: number
  clicks: number
  reach: number
  leads: number
  conversions: number
  /** null = the row did not record it (synced before it was imported). */
  messages: number | null
  purchases: number | null
  landingPageViews: number | null
  exchangeRate: number
}

export interface ReportRawData {
  project: ReportProject
  metrics: ReportMetricRow[]            // primary period
  comparisonMetrics: ReportMetricRow[]  // comparison period (empty if not requested)
  branding: BrandConfig
  /** Unique reach for the whole primary / comparison period, from the provider. */
  periodReach?: PeriodReach
  comparisonPeriodReach?: PeriodReach
  dataQuality?: DataQuality
  /** Client report: each campaign's own data, for the per-campaign breakdown. */
  campaigns?: { project: ReportProject; metrics: ReportMetricRow[] }[]
}

/** One campaign's line in a client report. */
export interface CampaignBreakdownRow {
  projectId: string
  campaignName: string
  objective: string | null
  resultLabel: string | null
  costLabel: string | null
  /** null = the objective has no result metric, or it was not recorded. */
  results: number | null
  costPerResult: number | null
  spend: number
  impressions: number
  clicks: number
}

// ─── Brand Config (output of Branding Engine) ────────────────────────────────

export interface BrandConfig {
  agencyName: string
  clientName: string
  primaryColor: string
  secondaryColor: string
  accentColor: string
  logoUrl: string | null
  agencyLogoUrl: string | null
  contactPhone: string | null
  contactEmail: string | null
  contactWebsite: string | null
  footerText: string | null
  whiteLabelMode: WhiteLabelMode
  confidentialWatermark: boolean
  showPoweredBy: boolean
  backgroundDesign?: string
  bgImageTopUrl?: string | null
  bgImageBottomUrl?: string | null
}

// ─── Template Config (output of Template Engine) ─────────────────────────────

export interface TemplateConfig {
  name: ReportTemplate
  displayName: string
  /** Which KPI sections to show in this template. */
  sections: TemplateSections
  /** Primary KPI emphasis (drives AI narrative focus). */
  primaryKPI: 'roas' | 'leads' | 'revenue' | 'reach' | 'spend'
}

export interface TemplateSections {
  executiveSummary: boolean
  kpiScorecard: boolean
  dailyBreakdown: boolean
  campaignHealth: boolean
  benchmarkComparison: boolean
  forecast: boolean
  aiInsights: boolean
  budgetAnalysis: boolean
  recommendations: boolean
}

// ─── KPI Data (output of KPI Engine) ─────────────────────────────────────────

export interface KPIData {
  /** Aggregated metrics for the primary period. */
  primary: AggregateMetrics
  /** Aggregated metrics for the comparison period (undefined if no comparison). */
  comparison?: AggregateMetrics
  /** Delta between primary and comparison, as signed percentages. */
  deltas?: KPIDeltas
  /** Daily aggregated metrics series. */
  dailySeries: DailySeriesPoint[]
  /** Weekly aggregated metrics series. */
  weeklySeries: WeeklySeriesPoint[]
  /** Additional derived KPIs. */
  derived: DerivedKPIs
  /** De-duplicated reach for the whole period. `primary.reach` is the SUM of
   *  daily reach and must not be presented as unique people. Absent on old
   *  snapshots. */
  periodReach?: PeriodReach
}

/** Signed % changes. `null` = not comparable: the baseline is zero (growth
 *  from nothing is "new", not +100%) or the ratio is undefined on a side. */
export interface KPIDeltas {
  spendDelta: number | null
  revenueDelta: number | null
  impressionsDelta: number | null
  clicksDelta: number | null
  reachDelta: number | null
  leadsDelta: number | null
  roasDelta: number | null
  ctrDelta: number | null
  cpcDelta: number | null
  cpmDelta: number | null
  cplDelta: number | null
  /** The objective's result (conversations, purchases…) — absent on old snapshots. */
  resultsDelta?: number | null
  costPerResultDelta?: number | null
}

export interface DailySeriesPoint {
  date: string
  spend: number
  revenue: number
  impressions: number
  clicks: number
  reach: number
  leads: number
  roas: number
  ctr: number
  /** Results for the campaign's objective (see result-type.ts); null when
   *  the objective has no imported result metric. */
  results?: number | null
  /** Spend ÷ results. null when unavailable or no results — never a cost of
   *  some other metric. */
  cpr: number | null
  /** Actual money spent including GST */
  actualCost: number
  gstAmount: number
  remainingAllocation: number
}

export interface WeeklySeriesPoint extends DailySeriesPoint {
  weekLabel: string
}

export interface DerivedKPIs {
  profit: number            // revenue - spend
  margin: number            // (profit / revenue) * 100
  roi: number               // (profit / spend) * 100
  conversionRate: number    // (leads / clicks) * 100
  /** Spend ÷ objective results; null when unavailable or zero results. */
  costPerResult: number | null
  /** Which metric `results`/`costPerResult` count (absent on old snapshots). */
  result?: ResultDefinition
  results?: number | null
  /** Days that recorded the result metric vs days in the period. Fewer
   *  recorded days means the result count is incomplete. */
  resultCoverage?: { recordedDays: number; days: number }
  budgetUtilisation: number // (spend / budget) * 100
  avgDailySpend: number
  avgDailyLeads: number
  campaignDuration: number  // days in range
  remainingBudget: number   // deprecated fallback, use remainingAllocation
  actualCost: number
  gstAmount: number
  /** Allocation left at the end of the period: openingBalance - actualCost. */
  remainingAllocation: number
}

// ─── Benchmark Summary (output of Benchmark Engine) ──────────────────────────

export interface BenchmarkSummary {
  metrics: BenchmarkMetrics
  source: 'campaign' | 'client' | 'agency' | 'industry' | 'global'
  roasVsBenchmark: number   // % above/below
  ctrVsBenchmark: number
  cpcVsBenchmark: number
  cplVsBenchmark: number
}

// ─── Forecast Bundle ──────────────────────────────────────────────────────────

export interface ForecastBundle {
  spend7d: ForecastResult
  spend30d: ForecastResult
  spend90d: ForecastResult
  leads7d: ForecastResult
  leads30d: ForecastResult
  roas30d: ForecastResult
}

// ─── Health Summary ───────────────────────────────────────────────────────────

export interface HealthSummary {
  result: HealthScoreResult
  grade: string
  risk: string
  score: number
  /** Single-line verdict for the PDF/image header. */
  verdict: string
}

// ─── AI Narrative (output of AI Engine) ──────────────────────────────────────

export interface AIReport {
  executiveSummary: string
  keyInsights: string[]
  risks: string[]
  opportunities: string[]
  recommendedActions: string[]
  budgetRecommendations: string
  generatedAt: string
  /** AI model used (e.g. gpt-4o-mini). */
  model?: string
}

// ─── Render Data (output of Render Engine) ───────────────────────────────────
// This is the complete, self-contained payload stored in ad_reports.render_data.
// All exporters (PDF, Excel, CSV, Image) derive their output from this.

export interface RenderData {
  snapshotId?: string
  config: ReportConfig
  template: TemplateConfig
  brand: BrandConfig
  project: ReportProject
  kpi: KPIData
  benchmarks: BenchmarkSummary
  forecasts: ForecastBundle
  health: HealthSummary
  ai: AIReport
  /** Which days had data; absent on snapshots made before it existed. */
  dataQuality?: DataQuality
  /** Client report (2+ campaigns): one row per campaign. */
  campaigns?: CampaignBreakdownRow[]
  generatedAt: string
}

// ─── Schedule ─────────────────────────────────────────────────────────────────

export type ScheduleFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'custom'

export interface ReportSchedule {
  id: string
  projectId: string
  clientId: string
  frequency: ScheduleFrequency
  cronExpression: string | null
  deliveryHour: number
  deliveryTimezone: string
  reportType: ReportType
  template: ReportTemplate
  formats: ReportFormat[]
  includeComparison: boolean
  recipients: ReportRecipient[]
  isActive: boolean
  lastRunAt: string | null
  nextRunAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

// ─── Report Record ────────────────────────────────────────────────────────────

export interface ReportRecord {
  id: string
  projectId: string
  clientId: string
  reportType: ReportType
  template: ReportTemplate
  dateFrom: string
  dateTo: string
  comparisonFrom: string | null
  comparisonTo: string | null
  status: ReportStatus
  errorMessage: string | null
  generationTimeMs: number | null
  pdfUrl: string | null
  xlsxUrl: string | null
  csvUrl: string | null
  imageUrlPortrait: string | null
  imageUrlSquare: string | null
  renderData: RenderData | null
  aiNarrative: AIReport | null
  generatedBy: string | null
  scheduleId: string | null
  createdAt: string
  generatedAt: string | null
}

// ─── Export Result ────────────────────────────────────────────────────────────

export interface ExportResult {
  format: ReportFormat
  storageKey: string    // path inside the ad-reports bucket
  publicUrl: string     // signed URL (or permanent URL)
  sizeBytes: number
  mimeType?: string
}

// ─── Delivery Result ─────────────────────────────────────────────────────────

/** One recipient's e-mail outcome. `accepted` = the provider took the
 *  message for sending; it is NOT confirmation of inbox delivery. */
export interface DeliveryResult {
  email: string
  status: 'accepted' | 'failed' | 'sending' | 'delivered' | 'bounced'
  providerId?: string
  error?: string
}

export interface ExportFailure {
  format: ReportFormat
  error: string
}

// ─── Orchestration Result ────────────────────────────────────────────────────

export interface OrchestrationResult {
  reportId: string
  /** Ready = all requested formats; partial = some; failed = none or interrupted. */
  status: 'ready' | 'partial' | 'failed'
  generationTimeMs: number
  formats: ReportFormat[]
  exports: ExportResult[]
  failedFormats: ExportFailure[]
  delivery: DeliveryResult[]
  error?: string
}
