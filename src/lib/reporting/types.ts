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

// ─── Report Config ────────────────────────────────────────────────────────────

export type ReportType = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'custom'
export type ReportTemplate = 'executive' | 'marketing' | 'lead_gen' | 'ecommerce' | 'performance' | 'agency' | 'daily'
export type ReportFormat = 'pdf' | 'xlsx' | 'csv' | 'image_portrait' | 'image_square'
export type WhiteLabelMode = 'cirqle' | 'client' | 'agency'
export type ReportStatus = 'pending' | 'generating' | 'ready' | 'failed'

export interface ReportConfig {
  projectId: string
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
  objective: string | null
  startDate: string | null
  endDate: string | null
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
  exchangeRate: number
}

export interface ReportRawData {
  project: ReportProject
  metrics: ReportMetricRow[]            // primary period
  comparisonMetrics: ReportMetricRow[]  // comparison period (empty if not requested)
  branding: BrandConfig
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
}

export interface KPIDeltas {
  spendDelta: number        // %
  revenueDelta: number      // %
  impressionsDelta: number  // %
  clicksDelta: number       // %
  reachDelta: number        // %
  leadsDelta: number        // %
  roasDelta: number         // %
  ctrDelta: number          // %
  cpcDelta: number          // %
  cpmDelta: number          // %
  cplDelta: number          // %
}

export interface DailySeriesPoint {
  date: string
  spend: number
  revenue: number
  impressions: number
  clicks: number
  leads: number
  roas: number
  ctr: number
}

export interface WeeklySeriesPoint extends DailySeriesPoint {
  weekLabel: string
}

export interface DerivedKPIs {
  profit: number            // revenue - spend
  margin: number            // (profit / revenue) * 100
  roi: number               // (profit / spend) * 100
  conversionRate: number    // (leads / clicks) * 100
  costPerResult: number     // spend / (leads || conversions || clicks)
  budgetUtilisation: number // (spend / budget) * 100
  avgDailySpend: number
  avgDailyLeads: number
  campaignDuration: number  // days in range
  remainingBudget: number   // budget - spend
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
  config: ReportConfig
  template: TemplateConfig
  brand: BrandConfig
  project: ReportProject
  kpi: KPIData
  benchmarks: BenchmarkSummary
  forecasts: ForecastBundle
  health: HealthSummary
  ai: AIReport
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
}

// ─── Delivery Result ─────────────────────────────────────────────────────────

export interface DeliveryResult {
  format: ReportFormat
  export: ExportResult
  emailDelivered: boolean
  emailRecipients: string[]
  error?: string
}

// ─── Orchestration Result ────────────────────────────────────────────────────

export interface OrchestrationResult {
  reportId: string
  status: 'ready' | 'failed'
  generationTimeMs: number
  formats: ReportFormat[]
  exports: ExportResult[]
  delivery: DeliveryResult[]
  error?: string
}
