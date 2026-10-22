/**
 * Device valuation (design §8–9).
 *
 *   Model value   V(d) = Price × max(Floor, 1 − Age ÷ Life) × Condition
 *   Value used        = evidenced resale value if entered, else V(window start)
 *   Remaining life R  = max(Minimum remaining, Life − Age)            (months)
 *   Monthly wear W    = Value used ÷ R
 *   Usage value       = W × months used × business share
 *                       (+ employee-paid repairs in the window × business share)
 *   Transfer value    = Value used on the transfer date
 *
 * There is NO approved policy until an Admin approves a versioned one (D11).
 * PROVISIONAL_DEVICE_POLICY only pre-fills the draft form; nothing is ever
 * confirmed against it. Task categories suggest which kind of device the work
 * needed; they never prove which physical device was used — that is why the
 * share is labelled Estimated unless an Admin records a Verified one.
 */

import { round2 } from '@/lib/calculations/currency'

// Local, so this module stays importable by the browser (the settings form)
// without pulling in the capital module's server-side imports.
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

export type DeviceCategory = 'phone' | 'laptop' | 'tablet' | 'desktop' | 'camera' | 'other'
export type DeviceCondition = 'excellent' | 'good' | 'fair' | 'poor'
export type DeviceNeed = 'laptop' | 'phone' | 'both' | 'none'

export const DEVICE_CATEGORIES: readonly DeviceCategory[] = ['phone', 'laptop', 'tablet', 'desktop', 'camera', 'other']
export const DEVICE_CONDITIONS: readonly DeviceCondition[] = ['excellent', 'good', 'fair', 'poor']

export interface DevicePolicy {
  lifeMonths: Record<DeviceCategory, number>
  floorPct: number
  minRemainingMonths: number
  conditionFactors: Record<DeviceCondition, number>
  /** On a day with Cirqle work, the share of the device's use that is for Cirqle. 0–1. */
  dailyWorkShare: Record<DeviceCategory, number>
  /** service_categories.id → the kind of device that work needs. */
  deviceNeedMap: Record<string, DeviceNeed>
  /** Resale value above this multiple of the model value needs a reason. */
  marketToleranceMultiple: number
}

/** Illustrative values from design §8.4. NOT approved — a starting draft only. */
export const PROVISIONAL_DEVICE_POLICY: DevicePolicy = {
  lifeMonths: { phone: 36, laptop: 48, tablet: 36, desktop: 60, camera: 60, other: 36 },
  floorPct: 10,
  minRemainingMonths: 12,
  conditionFactors: { excellent: 1, good: 0.9, fair: 0.75, poor: 0.5 },
  dailyWorkShare: { phone: 0.3, laptop: 0.7, tablet: 0.5, desktop: 0.7, camera: 0.5, other: 0.5 },
  deviceNeedMap: {},
  marketToleranceMultiple: 1.5,
}

export function validateDevicePolicy(p: DevicePolicy): string[] {
  const errors: string[] = []
  for (const c of DEVICE_CATEGORIES) {
    if (!(p.lifeMonths?.[c] > 0)) errors.push(`Useful life for ${c} must be above 0 months`)
    const s = p.dailyWorkShare?.[c]
    if (!(s >= 0 && s <= 1)) errors.push(`Daily work share for ${c} must be between 0 and 1`)
  }
  for (const c of DEVICE_CONDITIONS) {
    const f = p.conditionFactors?.[c]
    if (!(f > 0 && f <= 1)) errors.push(`Condition factor for ${c} must be above 0 and at most 1`)
  }
  if (!(p.floorPct >= 0 && p.floorPct <= 100)) errors.push('Floor must be between 0% and 100%')
  if (!(p.minRemainingMonths >= 1)) errors.push('Minimum remaining life must be at least 1 month')
  if (!(p.marketToleranceMultiple >= 1)) errors.push('Market-value tolerance must be at least 1×')
  return errors
}

const parts = (d: string) => d.split('-').map(Number) as [number, number, number]

/** Calendar months from `from` to `to` (1 Jan → 1 Apr = 3). Part months count by day. */
export function monthsBetween(from: string, to: string): number {
  const [y1, m1, d1] = parts(from)
  const [y2, m2, d2] = parts(to)
  return (y2 - y1) * 12 + (m2 - m1) + (d2 - d1) / 30
}

/** Which device-need kinds count as evidence for a device category. */
export function needsMatching(category: DeviceCategory): DeviceNeed[] {
  if (category === 'phone' || category === 'tablet') return ['phone', 'both']
  if (category === 'laptop' || category === 'desktop') return ['laptop', 'both']
  return [] // cameras and others have no task evidence: verified share only
}

export interface UsageEvidence {
  availableDays: number
  deviceWorkDays: number
  tasksConsidered: number
  /** device-work days ÷ available days × daily work share. */
  estimatedShare: number
}

/**
 * Task-based usage evidence (design §8.3). Counts distinct dates inside the
 * available window that have at least one task whose service category needs
 * this kind of device.
 */
export function usageEvidence(input: {
  tasks: { date: string; serviceCategoryId: string | null }[]
  policy: DevicePolicy
  category: DeviceCategory
  windowStart: string
  windowEnd: string
}): UsageEvidence {
  const kinds = needsMatching(input.category)
  const inWindow = input.tasks.filter(t => t.date >= input.windowStart && t.date <= input.windowEnd)
  const days = new Set<string>()
  for (const t of inWindow) {
    const need = t.serviceCategoryId ? input.policy.deviceNeedMap[t.serviceCategoryId] : undefined
    if (need && kinds.includes(need)) days.add(t.date)
  }
  const available = Math.max(0, Math.round((Date.parse(`${input.windowEnd}T00:00:00Z`) - Date.parse(`${input.windowStart}T00:00:00Z`)) / 86_400_000) + 1)
  const daily = input.policy.dailyWorkShare[input.category] ?? 0
  return {
    availableDays: available,
    deviceWorkDays: days.size,
    tasksConsidered: inWindow.length,
    estimatedShare: available > 0 ? Math.min(1, days.size / available) * daily : 0,
  }
}

export interface DeviceFacts {
  category: DeviceCategory
  condition: DeviceCondition
  purchaseDate: string
  priceInr: number
  priceIsEstimated: boolean
  usageStart: string | null
  usageEnd: string | null
  joinedDate: string | null
  exitDate: string | null
}

/** The usage window, narrowed to when the device could actually have been used for Cirqle. */
export function effectiveWindow(f: DeviceFacts, windowStart: string, windowEnd: string): { start: string; end: string } | null {
  const start = [windowStart, f.usageStart, f.joinedDate, f.purchaseDate].filter(Boolean).sort().at(-1) as string
  const end = [windowEnd, f.usageEnd, f.exitDate].filter(Boolean).sort()[0] as string
  return start <= end ? { start, end } : null
}

export function modelValue(f: DeviceFacts, policy: DevicePolicy, onDate: string): { ageMonths: number; value: number } {
  const age = Math.max(0, monthsBetween(f.purchaseDate, onDate))
  const life = policy.lifeMonths[f.category]
  const factor = Math.max(policy.floorPct / 100, 1 - age / life)
  return { ageMonths: age, value: f.priceInr * factor * (policy.conditionFactors[f.condition] ?? 1) }
}

export interface UsageValuation {
  window: { start: string; end: string } | null
  ageMonths: number
  modelValueInr: number
  valueUsedInr: number
  remainingLifeMonths: number
  monthlyWearInr: number
  monthsUsed: number
  businessShare: number
  basis: 'estimated' | 'verified'
  repairsInr: number
  proposedInr: number
  /** Resale value entered above the tolerance: a reason is required. */
  marketAboveTolerance: boolean
}

export function valueUsage(input: {
  facts: DeviceFacts
  policy: DevicePolicy
  windowStart: string
  windowEnd: string
  marketValueInr?: number | null
  estimatedShare: number
  verifiedShare?: number | null
  /** Repairs/maintenance the EMPLOYEE paid for, with their dates. */
  employeeRepairs?: { date: string; costInr: number }[]
}): UsageValuation {
  const { facts, policy } = input
  const window = effectiveWindow(facts, input.windowStart, input.windowEnd)
  const at = window?.start ?? input.windowStart
  const { ageMonths, value } = modelValue(facts, policy, at)
  const valueUsed = input.marketValueInr != null && input.marketValueInr > 0 ? input.marketValueInr : value
  const remaining = Math.max(policy.minRemainingMonths, policy.lifeMonths[facts.category] - ageMonths)
  const wear = valueUsed / remaining
  const months = window ? Math.max(0, monthsBetween(window.start, addDays(window.end, 1))) : 0
  const verified = input.verifiedShare != null
  const share = verified ? (input.verifiedShare as number) : input.estimatedShare
  const repairs = window
    ? (input.employeeRepairs ?? []).filter(r => r.date >= window.start && r.date <= window.end).reduce((s, r) => s + r.costInr, 0)
    : 0
  return {
    window,
    ageMonths,
    modelValueInr: round2(value),
    valueUsedInr: round2(valueUsed),
    remainingLifeMonths: round2(remaining),
    monthlyWearInr: round2(wear),
    monthsUsed: round2(months),
    businessShare: share,
    basis: verified ? 'verified' : 'estimated',
    repairsInr: round2(repairs),
    proposedInr: window ? round2(wear * months * share + repairs * share) : 0,
    marketAboveTolerance: input.marketValueInr != null && input.marketValueInr > value * policy.marketToleranceMultiple,
  }
}

export function valueTransfer(input: {
  facts: DeviceFacts
  policy: DevicePolicy
  asOf: string
  marketValueInr?: number | null
}): { ageMonths: number; modelValueInr: number; proposedInr: number; marketAboveTolerance: boolean } {
  const { ageMonths, value } = modelValue(input.facts, input.policy, input.asOf)
  const used = input.marketValueInr != null && input.marketValueInr > 0 ? input.marketValueInr : value
  return {
    ageMonths,
    modelValueInr: round2(value),
    proposedInr: round2(used),
    marketAboveTolerance: input.marketValueInr != null && input.marketValueInr > value * input.policy.marketToleranceMultiple,
  }
}
