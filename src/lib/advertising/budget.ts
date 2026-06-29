/**
 * Advertising — budget & billing math (pure, unit-tested).
 *
 * Two budgets per project (PRD):
 *   • Advertising Spend  — money spent inside the platform (e.g. ₹20,000 Meta).
 *   • Service Charge     — agency fee, either a fixed amount or a percent of the
 *                          ad spend (e.g. ₹3,000 or 15%).
 *
 * From those the system derives Subtotal, Tax and Grand Total for the invoice.
 *
 * Tax base note: v1 applies tax to the subtotal (ad spend + service charge),
 * matching the PRD's literal Subtotal → Tax → Grand Total flow. If ad spend is a
 * non-taxable pass-through in your jurisdiction, set tax_percent to 0 on the
 * project; a per-component tax base can be added later without a schema change.
 */

import type { ServiceChargeType, BudgetInputMode } from './types'

export interface BudgetInput {
  adBudget: number
  serviceChargeType: ServiceChargeType | string
  serviceChargeValue: number
  taxPercent?: number
}

export interface BudgetTotals {
  adSpend: number
  serviceCharge: number
  subtotal: number
  tax: number
  grandTotal: number
}

const round2 = (v: number): number =>
  Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100

/** Resolve the agency service charge from its type + value. */
export function computeServiceCharge(
  adBudget: number,
  type: ServiceChargeType | string,
  value: number,
): number {
  const v = Number(value || 0)
  if (type === 'percent') return round2((Number(adBudget || 0) * v) / 100)
  return round2(v)
}

// ─── Daily budget × duration ────────────────────────────────────────────────
// A client often briefs a *daily* budget instead of a lump sum ("₹3,000/day").
// These resolve that into the total ad spend the rest of the module bills on.

/** Inclusive day count between two ISO dates (start & end both counted). 0 if invalid/missing. */
export function daysBetween(start?: string | null, end?: string | null): number {
  if (!start || !end) return 0
  const s = new Date(start).getTime()
  const e = new Date(end).getTime()
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return 0
  return Math.floor((e - s) / 86_400_000) + 1
}

/**
 * Resolve a duration preset to a number of days. Numeric presets ('7','14','30')
 * map to themselves; 'custom' uses the inclusive start→end range.
 */
export function daysForDuration(preset: string, startDate?: string | null, endDate?: string | null): number {
  if (preset === 'custom') return daysBetween(startDate, endDate)
  const n = parseInt(preset, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export interface ResolveAdSpendInput {
  mode: BudgetInputMode | string
  /** Used when mode === 'total'. */
  adBudget?: number | string | null
  /** Used when mode === 'daily'. */
  dailyBudget?: number | string | null
  durationPreset?: string
  startDate?: string | null
  endDate?: string | null
}

/**
 * Resolve the total advertising spend (and the day count used) from either a
 * direct total or a daily budget × duration. The total it returns is the single
 * value the budget/invoice math (computeBudgetTotals) consumes.
 */
export function resolveAdSpend(input: ResolveAdSpendInput): { adSpend: number; days: number } {
  if (input.mode === 'daily') {
    const days = daysForDuration(input.durationPreset || '', input.startDate, input.endDate)
    return { adSpend: round2(Number(input.dailyBudget || 0) * days), days }
  }
  return { adSpend: round2(Number(input.adBudget || 0)), days: 0 }
}

/** Full breakdown for the invoice / budget panel. */
export function computeBudgetTotals(input: BudgetInput): BudgetTotals {
  const adSpend = round2(input.adBudget)
  const serviceCharge = computeServiceCharge(
    adSpend, input.serviceChargeType, input.serviceChargeValue,
  )
  const subtotal = round2(adSpend + serviceCharge)
  const tax = round2((subtotal * Number(input.taxPercent || 0)) / 100)
  const grandTotal = round2(subtotal + tax)
  return { adSpend, serviceCharge, subtotal, tax, grandTotal }
}
