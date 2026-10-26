/**
 * The campaign's headline result, as every report output shows it.
 *
 * The KPI engine already picks the result from the objective
 * (result-type.ts) — but the web preview, PDF scorecard, image hero, email
 * and exports each hard-coded "Leads / Cost per lead". A messages campaign
 * with 10 conversations therefore reported "Leads 0, Cost per lead —": true
 * of leads, and wrong about the campaign. Every output now reads its result
 * tiles from here, so they all say the same thing in the campaign's terms.
 */

import { resultDefinitionFor, type ResultDefinition } from './result-type'
import type { KPIData } from './types'

export interface ResultHeadline {
  definition: ResultDefinition
  /** "Conversations", "Leads", "Purchases"… */
  label: string
  /** "Cost per conversation"… */
  costLabel: string
  /** null = no result metric for this objective, or nothing recorded. */
  value: number | null
  /** null = no results to divide by — never shown as ₹0. */
  cost: number | null
  /** Why there is no figure (objective without an imported result). */
  reason: string | null
  /** The metric was recorded on only some of the period's days. */
  partial: boolean
  /** % change vs the comparison period, when there is one. */
  delta: number | null
  costDelta: number | null
  /** Lead campaigns keep their CPL benchmark and lead forecast. */
  isLeads: boolean
}

export function resultHeadline(kpi: KPIData, campaignType?: string | null): ResultHeadline {
  const d = kpi.derived
  // Snapshots made before result definitions existed carry no `result`:
  // re-derive it the same way the engine does, which counts leads.
  const definition = d.result ?? resultDefinitionFor(campaignType, { leads: kpi.primary.leads })
  const hasStored = d.result != null
  const value = definition.metric == null ? null
    : hasStored ? (d.results ?? null)
    : definition.metric === 'leads' ? kpi.primary.leads : null
  const cost = definition.metric == null ? null
    : hasStored ? d.costPerResult
    : value && value > 0 ? kpi.primary.spend / value : null
  const cov = d.resultCoverage
  return {
    definition,
    label: definition.label,
    costLabel: definition.costLabel,
    value,
    cost,
    reason: definition.metric == null ? (definition.unavailableReason ?? null) : null,
    partial: !!cov && cov.recordedDays < cov.days,
    delta: kpi.deltas?.resultsDelta ?? (definition.metric === 'leads' ? kpi.deltas?.leadsDelta ?? null : null),
    costDelta: kpi.deltas?.costPerResultDelta ?? (definition.metric === 'leads' ? kpi.deltas?.cplDelta ?? null : null),
    isLeads: definition.metric === 'leads' || (definition.metric == null && !d.result),
  }
}

/** "10" / "—" for the result count. */
export function formatResultValue(r: ResultHeadline): string {
  return r.value == null ? '—' : Math.round(r.value).toLocaleString('en-IN')
}

/** "₹35.62" / "—" for cost per result. */
export function formatResultCost(r: ResultHeadline, dp = 2): string {
  return r.cost == null ? '—' : `₹${r.cost.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
}
