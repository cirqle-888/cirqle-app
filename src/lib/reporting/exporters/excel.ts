/**
 * Excel Exporter
 *
 * Generates a multi-sheet .xlsx workbook from RenderData using the xlsx package.
 * Sheets: Summary | Daily Breakdown | Weekly | Forecast | AI Narrative
 */

import * as XLSX from 'xlsx'
import type { RenderData } from '../types'

/**
 * Generates an Excel buffer from RenderData.
 */
export function generateExcel(data: RenderData): Buffer {
  const wb = XLSX.utils.book_new()

  addSummarySheet(wb, data)
  addDailySheet(wb, data)
  addWeeklySheet(wb, data)
  addForecastSheet(wb, data)
  addAISheet(wb, data)

  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
}

// ─── Sheet builders ───────────────────────────────────────────────────────────

function addSummarySheet(wb: XLSX.WorkBook, d: RenderData) {
  const p = d.kpi.primary
  const bm = d.benchmarks.metrics
  const derived = d.kpi.derived

  const rows: (string | number)[][] = [
    ['CAMPAIGN REPORT', '', '', ''],
    ['Campaign', d.project.campaignName],
    ['Platform', d.project.platform.toUpperCase()],
    ['Client', d.project.clientName],
    ['Report Period', `${d.config.dateFrom} to ${d.config.dateTo}`],
    ['Template', d.template.displayName],
    ['Generated At', d.generatedAt],
    [''],
    ['HEALTH SCORE', '', '', ''],
    ['Score', d.health.score],
    ['Grade', d.health.grade],
    ['Risk', d.health.risk],
    ['Verdict', d.health.verdict],
    [''],
    ['KEY METRICS', 'Value', 'Benchmark', 'vs Benchmark (%)'],
    ['Spend (₹)', p.spend, '', ''],
    ['Revenue (₹)', p.revenue, '', ''],
    ['Budget (₹)', d.project.adBudget, '', ''],
    ['Budget Utilisation (%)', derived.budgetUtilisation, '', ''],
    ['Remaining Budget (₹)', derived.remainingBudget, '', ''],
    ['ROAS', p.roas, bm.roas, d.benchmarks.roasVsBenchmark],
    ['CTR (%)', p.ctr, bm.ctr, d.benchmarks.ctrVsBenchmark],
    ['CPC (₹)', p.cpc, bm.cpc, d.benchmarks.cpcVsBenchmark],
    ['CPM (₹)', p.cpm, bm.cpm, 0],
    ['CPL (₹)', p.cpl, bm.cpa, d.benchmarks.cplVsBenchmark],
    ['Impressions', p.impressions, '', ''],
    ['Reach', p.reach, '', ''],
    ['Clicks', p.clicks, '', ''],
    ['Leads', p.leads, '', ''],
    ['Conversions', p.conversions, '', ''],
    ['Profit (₹)', derived.profit, '', ''],
    ['Margin (%)', derived.margin, '', ''],
    ['ROI (%)', derived.roi, '', ''],
    ['Conversion Rate (%)', derived.conversionRate, bm.conversion_rate, ''],
    ['Avg Daily Spend (₹)', derived.avgDailySpend, '', ''],
    ['Avg Daily Leads', derived.avgDailyLeads, '', ''],
  ]

  // Comparison period
  if (d.kpi.comparison && d.kpi.deltas) {
    rows.push([''])
    rows.push(['COMPARISON PERIOD', `${d.config.comparisonFrom} to ${d.config.comparisonTo}`])
    const cp = d.kpi.comparison
    const deltas = d.kpi.deltas
    rows.push(['Spend (₹)', cp.spend, '', `${deltaStr(deltas.spendDelta)}`])
    rows.push(['Revenue (₹)', cp.revenue, '', `${deltaStr(deltas.revenueDelta)}`])
    rows.push(['ROAS', cp.roas, '', `${deltaStr(deltas.roasDelta)}`])
    rows.push(['CTR (%)', cp.ctr, '', `${deltaStr(deltas.ctrDelta)}`])
    rows.push(['Leads', cp.leads, '', `${deltaStr(deltas.leadsDelta)}`])
    rows.push(['CPL (₹)', cp.cpl, '', `${deltaStr(deltas.cplDelta)}`])
  }

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = [{ wch: 30 }, { wch: 20 }, { wch: 20 }, { wch: 20 }]
  XLSX.utils.book_append_sheet(wb, ws, 'Summary')
}

function addDailySheet(wb: XLSX.WorkBook, d: RenderData) {
  const header = ['Date', 'Spend (₹)', 'Revenue (₹)', 'Impressions', 'Clicks', 'Leads', 'ROAS', 'CTR (%)']
  const rows = d.kpi.dailySeries.map(row => [
    row.date,
    round2(row.spend),
    round2(row.revenue),
    Math.round(row.impressions),
    Math.round(row.clicks),
    Math.round(row.leads),
    round2(row.roas),
    round2(row.ctr),
  ])
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows])
  ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }]
  XLSX.utils.book_append_sheet(wb, ws, 'Daily Breakdown')
}

function addWeeklySheet(wb: XLSX.WorkBook, d: RenderData) {
  const header = ['Week', 'Spend (₹)', 'Revenue (₹)', 'Impressions', 'Clicks', 'Leads', 'ROAS', 'CTR (%)']
  const rows = d.kpi.weeklySeries.map(row => [
    row.weekLabel,
    round2(row.spend),
    round2(row.revenue),
    Math.round(row.impressions),
    Math.round(row.clicks),
    Math.round(row.leads),
    round2(row.roas),
    round2(row.ctr),
  ])
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows])
  ws['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }]
  XLSX.utils.book_append_sheet(wb, ws, 'Weekly')
}

function addForecastSheet(wb: XLSX.WorkBook, d: RenderData) {
  const fc = d.forecasts
  const rows: (string | number)[][] = [
    ['FORECASTS', '', '', '', ''],
    ['Metric', 'Period', 'Forecast Value', 'Model', 'Confidence (%)', 'Trend'],
    ['Spend (₹)', '7 days',  round2(fc.spend7d.predicted_value),  fc.spend7d.model_used,  fc.spend7d.confidence,  fc.spend7d.trend],
    ['Spend (₹)', '30 days', round2(fc.spend30d.predicted_value), fc.spend30d.model_used, fc.spend30d.confidence, fc.spend30d.trend],
    ['Spend (₹)', '90 days', round2(fc.spend90d.predicted_value), fc.spend90d.model_used, fc.spend90d.confidence, fc.spend90d.trend],
    ['Leads',     '7 days',  round2(fc.leads7d.predicted_value),  fc.leads7d.model_used,  fc.leads7d.confidence,  fc.leads7d.trend],
    ['Leads',     '30 days', round2(fc.leads30d.predicted_value), fc.leads30d.model_used, fc.leads30d.confidence, fc.leads30d.trend],
    ['ROAS',      '30 days', round2(fc.roas30d.predicted_value),  fc.roas30d.model_used,  fc.roas30d.confidence,  fc.roas30d.trend],
  ]
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = [{ wch: 14 }, { wch: 10 }, { wch: 18 }, { wch: 22 }, { wch: 16 }, { wch: 10 }]
  XLSX.utils.book_append_sheet(wb, ws, 'Forecast')
}

function addAISheet(wb: XLSX.WorkBook, d: RenderData) {
  const ai = d.ai
  const rows: string[][] = [
    ['AI NARRATIVE', ''],
    ['Section', 'Content'],
    ['Executive Summary', ai.executiveSummary],
    ...ai.keyInsights.map((s, i) => [`Key Insight ${i + 1}`, s]),
    ...ai.risks.map((s, i) => [`Risk ${i + 1}`, s]),
    ...ai.opportunities.map((s, i) => [`Opportunity ${i + 1}`, s]),
    ...ai.recommendedActions.map((s, i) => [`Action ${i + 1}`, s]),
    ['Budget Recommendation', ai.budgetRecommendations],
    ['Generated At', ai.generatedAt],
    ['Model', ai.model ?? '—'],
  ]
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = [{ wch: 24 }, { wch: 80 }]
  XLSX.utils.book_append_sheet(wb, ws, 'AI Narrative')
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Canonical money rounding — a local Math.round(n * 100) / 100 disagrees at
// the .xx5 midpoints (1.005 -> 1.00 instead of 1.01) and would drift from
// the finance engines. See currency.ts round2.
import { round2 } from '@/lib/calculations/currency'
const deltaStr = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
