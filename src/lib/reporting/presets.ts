/**
 * Report presets and composer periods (plan Phase 4).
 *
 * Three visible presets replace picking from eight templates. Each maps to
 * an existing template + formats + sections, so old templates and report
 * history keep working; the eight templates stay reachable under
 * "Advanced". Periods are COMPLETED days only (yesterday back), because a
 * report that includes today shows partial numbers.
 */

import { addDaysISO } from '@/lib/utils/local-date'
import { MAX_RANGE_DAYS, daySpan } from './config'
import type { ReportFormat, ReportTemplate, ReportType, TemplateSections } from './types'

export type PresetKey = 'quick' | 'monthly' | 'detailed'
export type ComposerPeriod = 'yesterday' | 'last7' | 'last_month' | 'lifetime' | 'custom'

export interface ReportPreset {
  key: PresetKey
  label: string
  audience: string
  description: string
  template: ReportTemplate
  reportType: ReportType
  formats: ReportFormat[]
  withComparison: boolean
  sections?: Partial<TemplateSections>
  defaultPeriod: ComposerPeriod
}

export const REPORT_PRESETS: ReportPreset[] = [
  {
    key: 'quick', label: 'Quick update', audience: 'WhatsApp / manual share',
    description: 'Spend, objective results and cost per result as a phone-friendly image, plus a PDF.',
    template: 'daily', reportType: 'custom', formats: ['image_portrait', 'pdf'], withComparison: false,
    defaultPeriod: 'last7',
  },
  {
    key: 'monthly', label: 'Monthly client report', audience: 'Client review',
    description: 'Summary, comparison with the previous month, campaign breakdown and next steps.',
    template: 'monthly', reportType: 'monthly', formats: ['pdf'], withComparison: true,
    defaultPeriod: 'last_month',
  },
  {
    key: 'detailed', label: 'Detailed analysis', audience: 'Internal team',
    description: 'Daily metrics, health, benchmarks and forecasts, with Excel and CSV exports.',
    template: 'performance', reportType: 'custom', formats: ['pdf', 'xlsx', 'csv'], withComparison: true,
    sections: {
      executiveSummary: true, kpiScorecard: true, dailyBreakdown: true, campaignHealth: true,
      benchmarkComparison: true, forecast: true, aiInsights: true, budgetAnalysis: true, recommendations: true,
    },
    defaultPeriod: 'last_month',
  },
]

export const COMPOSER_PERIODS: { key: ComposerPeriod; label: string }[] = [
  { key: 'yesterday',  label: 'Yesterday' },
  { key: 'last7',      label: 'Last 7 completed days' },
  { key: 'last_month', label: 'Last month' },
  { key: 'lifetime',   label: 'Lifetime' },
  { key: 'custom',     label: 'Custom' },
]

export function presetByKey(key: PresetKey): ReportPreset {
  return REPORT_PRESETS.find(p => p.key === key) ?? REPORT_PRESETS[0]
}

/**
 * Inclusive dates for a composer period. `lifetime` starts at the earliest
 * campaign start (or `MAX_RANGE_DAYS` back when unknown) and is capped at
 * MAX_RANGE_DAYS so it stays a valid report range.
 */
export function composerRange(
  period: Exclude<ComposerPeriod, 'custom'>,
  today: string,
  earliestStart?: string | null,
): { dateFrom: string; dateTo: string } {
  const yesterday = addDaysISO(today, -1)
  switch (period) {
    case 'yesterday': return { dateFrom: yesterday, dateTo: yesterday }
    case 'last7':     return { dateFrom: addDaysISO(yesterday, -6), dateTo: yesterday }
    case 'last_month': {
      const [y, m] = today.split('-').map(Number)
      const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1
      const pad = (n: number) => String(n).padStart(2, '0')
      const last = new Date(Date.UTC(py, pm, 0)).getUTCDate()
      return { dateFrom: `${py}-${pad(pm)}-01`, dateTo: `${py}-${pad(pm)}-${pad(last)}` }
    }
    case 'lifetime':
    default: {
      const floor = addDaysISO(yesterday, -(MAX_RANGE_DAYS - 1))
      let from = earliestStart && earliestStart <= yesterday ? earliestStart : floor
      if (from < floor) from = floor
      return { dateFrom: from, dateTo: yesterday }
    }
  }
}

/**
 * When a campaign really started, for "Lifetime": its set start date, else the
 * first day it recorded data, else the day it was added to Cirqle. Without
 * this a campaign with no start date reported 400 days back — "ran from
 * 2025-09-21" for a campaign that began on 24 Oct 2026.
 */
export function campaignStartFor(p: {
  start_date?: string | null
  first_metric_date?: string | null
  created_at?: string | null
}): string | null {
  return p.start_date?.slice(0, 10) ?? p.first_metric_date?.slice(0, 10) ?? p.created_at?.slice(0, 10) ?? null
}

/** The equally long period immediately before [from, to]. */
export function previousPeriod(dateFrom: string, dateTo: string): { comparisonFrom: string; comparisonTo: string } {
  const days = daySpan(dateFrom, dateTo)
  const comparisonTo = addDaysISO(dateFrom, -1)
  return { comparisonFrom: addDaysISO(comparisonTo, -(days - 1)), comparisonTo }
}
