/**
 * CSV Exporter
 *
 * Generates a CSV string from RenderData.
 * Returns a single CSV with all KPI data (daily rows + summary row).
 */

import type { RenderData } from '../types'

/**
 * Generates a CSV buffer from RenderData.
 */
export function generateCSV(data: RenderData): Buffer {
  const lines: string[] = []

  // ── Report header ────────────────────────────────────────────────────────
  lines.push(`# ${data.project.campaignName} — ${data.template.displayName}`)
  lines.push(`# Period: ${data.config.dateFrom} to ${data.config.dateTo}`)
  lines.push(`# Client: ${data.project.clientName}`)
  lines.push(`# Platform: ${data.project.platform}`)
  lines.push(`# Generated: ${data.generatedAt}`)
  lines.push('')

  // ── Summary section ──────────────────────────────────────────────────────
  const p = data.kpi.primary
  const d = data.kpi.derived
  lines.push('## SUMMARY')
  lines.push('Metric,Value')
  lines.push(`Total Spend (₹),${p.spend.toFixed(2)}`)
  lines.push(`Total Revenue (₹),${p.revenue.toFixed(2)}`)
  lines.push(`Budget (₹),${data.project.adBudget.toFixed(2)}`)
  lines.push(`Budget Utilisation (%),${d.budgetUtilisation.toFixed(1)}`)
  lines.push(`ROAS,${p.roas.toFixed(2)}`)
  lines.push(`CTR (%),${p.ctr.toFixed(2)}`)
  lines.push(`CPC (₹),${p.cpc.toFixed(2)}`)
  lines.push(`CPM (₹),${p.cpm.toFixed(2)}`)
  lines.push(`Impressions,${Math.round(p.impressions)}`)
  lines.push(`Reach,${Math.round(p.reach)}`)
  lines.push(`Clicks,${Math.round(p.clicks)}`)
  lines.push(`Leads,${Math.round(p.leads)}`)
  lines.push(`CPL (₹),${p.cpl.toFixed(2)}`)
  lines.push(`Profit (₹),${d.profit.toFixed(2)}`)
  lines.push(`Margin (%),${d.margin.toFixed(1)}`)
  lines.push(`ROI (%),${d.roi.toFixed(1)}`)
  lines.push(`Conversion Rate (%),${d.conversionRate.toFixed(2)}`)
  lines.push(`Health Score,${data.health.score}`)
  lines.push(`Health Grade,${data.health.grade}`)
  lines.push('')

  // ── Daily breakdown ──────────────────────────────────────────────────────
  lines.push('## DAILY BREAKDOWN')
  lines.push('Date,Spend (₹),Revenue (₹),Impressions,Clicks,Leads,ROAS,CTR (%)')
  for (const row of data.kpi.dailySeries) {
    lines.push([
      row.date,
      row.spend.toFixed(2),
      row.revenue.toFixed(2),
      Math.round(row.impressions),
      Math.round(row.clicks),
      Math.round(row.leads),
      row.roas.toFixed(2),
      row.ctr.toFixed(2),
    ].join(','))
  }
  lines.push('')

  // ── Weekly breakdown ─────────────────────────────────────────────────────
  if (data.kpi.weeklySeries.length > 1) {
    lines.push('## WEEKLY BREAKDOWN')
    lines.push('Week,Spend (₹),Revenue (₹),Impressions,Clicks,Leads,ROAS,CTR (%)')
    for (const row of data.kpi.weeklySeries) {
      lines.push([
        row.weekLabel,
        row.spend.toFixed(2),
        row.revenue.toFixed(2),
        Math.round(row.impressions),
        Math.round(row.clicks),
        Math.round(row.leads),
        row.roas.toFixed(2),
        row.ctr.toFixed(2),
      ].join(','))
    }
    lines.push('')
  }

  // ── Forecast ─────────────────────────────────────────────────────────────
  lines.push('## FORECAST')
  lines.push('Metric,Period,Forecast Value,Model,Confidence (%),Trend')
  const fc = data.forecasts
  lines.push(`Spend (₹),7 days,${fc.spend7d.predicted_value.toFixed(2)},${fc.spend7d.model_used},${fc.spend7d.confidence},${fc.spend7d.trend}`)
  lines.push(`Spend (₹),30 days,${fc.spend30d.predicted_value.toFixed(2)},${fc.spend30d.model_used},${fc.spend30d.confidence},${fc.spend30d.trend}`)
  lines.push(`Spend (₹),90 days,${fc.spend90d.predicted_value.toFixed(2)},${fc.spend90d.model_used},${fc.spend90d.confidence},${fc.spend90d.trend}`)
  lines.push(`Leads,7 days,${fc.leads7d.predicted_value.toFixed(2)},${fc.leads7d.model_used},${fc.leads7d.confidence},${fc.leads7d.trend}`)
  lines.push(`Leads,30 days,${fc.leads30d.predicted_value.toFixed(2)},${fc.leads30d.model_used},${fc.leads30d.confidence},${fc.leads30d.trend}`)
  lines.push(`ROAS,30 days,${fc.roas30d.predicted_value.toFixed(2)},${fc.roas30d.model_used},${fc.roas30d.confidence},${fc.roas30d.trend}`)
  lines.push('')

  // ── AI narrative ─────────────────────────────────────────────────────────
  lines.push('## AI NARRATIVE')
  lines.push(`Executive Summary,"${csvEscape(data.ai.executiveSummary)}"`)
  data.ai.keyInsights.forEach((s, i) => lines.push(`Key Insight ${i + 1},"${csvEscape(s)}"`))
  data.ai.risks.forEach((s, i) => lines.push(`Risk ${i + 1},"${csvEscape(s)}"`))
  data.ai.opportunities.forEach((s, i) => lines.push(`Opportunity ${i + 1},"${csvEscape(s)}"`))
  data.ai.recommendedActions.forEach((s, i) => lines.push(`Action ${i + 1},"${csvEscape(s)}"`))
  lines.push(`Budget Recommendation,"${csvEscape(data.ai.budgetRecommendations)}"`)

  return Buffer.from(lines.join('\n'), 'utf-8')
}

/** Escapes a string for safe embedding inside CSV double-quotes. */
function csvEscape(s: string): string {
  return s.replace(/"/g, '""').replace(/\n/g, ' ')
}
