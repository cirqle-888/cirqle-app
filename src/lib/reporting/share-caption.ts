import type { RenderData } from './types'
import { describeDataQuality } from './data-quality'

/** Client-safe factual caption, derived exclusively from a saved snapshot. */
export function buildShareCaption(data: RenderData): string {
  const money = (value: number) => `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
  const { primary, derived, periodReach } = data.kpi
  const lines = [
    `${data.project.clientName} — ${data.project.campaignName}`,
    `${data.config.dateFrom} to ${data.config.dateTo}`,
    `Ad spend: ${money(primary.spend)}`,
  ]
  if (data.campaigns && data.campaigns.length > 1) {
    // Client report: each campaign's own result — never one mixed total.
    for (const c of data.campaigns) {
      lines.push(c.resultLabel
        ? `${c.campaignName}: ${c.results == null ? 'not available' : c.results.toLocaleString('en-IN')} ${c.resultLabel.toLowerCase()}${c.costPerResult != null ? ` (${money(c.costPerResult)} each)` : ''}`
        : `${c.campaignName}: ${money(c.spend)} spend`)
    }
  } else if (derived.result?.metric) {
    lines.push(`${derived.result.label}: ${derived.results == null ? 'Not available' : derived.results.toLocaleString('en-IN')}`)
    lines.push(`${derived.result.costLabel}: ${derived.costPerResult == null ? 'Not available' : money(derived.costPerResult)}`)
  } else if (periodReach?.available) {
    lines.push(`Reach: ${periodReach.value.toLocaleString('en-IN')}`)
  } else {
    lines.push(`Impressions: ${primary.impressions.toLocaleString('en-IN')}`)
  }
  const quality = describeDataQuality(data.dataQuality)
  if (quality) lines.push(quality)
  if (derived.resultCoverage && derived.resultCoverage.recordedDays < derived.resultCoverage.days) {
    lines.push('Some result data is missing; these results are incomplete.')
  }
  lines.push('Next step: review the results and agree on the next campaign update.')
  return lines.join('\n')
}
