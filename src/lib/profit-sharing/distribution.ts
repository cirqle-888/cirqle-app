/**
 * Loss carry-forward and the distribution pool (design §7.1–7.2).
 *
 * Confirmed rules: losses are absorbed before anything is distributed; 50% of
 * eligible profit forms the pool; the pool splits into Capital Share and
 * Business Reserve, which always total exactly 100%; the rest stays in the
 * business. Every figure is rounded to the paisa and the parts always add up.
 */

import { round2 } from '@/lib/calculations/currency'
import type { Settings } from './types'

export interface LossCarry {
  openingLossInr: number
  resultInr: number
  lossOffsetInr: number
  closingLossInr: number
  eligibleProfitInr: number
}

export function carryLoss(openingLossInr: number, resultInr: number): LossCarry {
  const opening = round2(Math.max(0, openingLossInr))
  const result = round2(resultInr)
  const offset = round2(Math.min(opening, Math.max(0, result)))
  return {
    openingLossInr: opening,
    resultInr: result,
    lossOffsetInr: offset,
    closingLossInr: round2(opening - offset + Math.max(0, -result)),
    eligibleProfitInr: round2(Math.max(0, result - offset)),
  }
}

export interface Distribution {
  eligibleProfitInr: number
  poolInr: number
  capitalShareInr: number
  reserveInr: number
  retainedOutsideInr: number
  totalRetainedInr: number
}

export function distribute(eligibleProfitInr: number, s: Pick<Settings, 'distributionPct' | 'capitalSharePct'>): Distribution {
  const eligible = round2(Math.max(0, eligibleProfitInr))
  const pool = round2((eligible * s.distributionPct) / 100)
  const capitalShare = round2((pool * s.capitalSharePct) / 100)
  // The reserve takes whatever the Capital Share did not, so the two always
  // add up to the pool exactly.
  const reserve = round2(pool - capitalShare)
  const retainedOutside = round2(eligible - pool)
  return {
    eligibleProfitInr: eligible,
    poolInr: pool,
    capitalShareInr: capitalShare,
    reserveInr: reserve,
    retainedOutsideInr: retainedOutside,
    totalRetainedInr: round2(reserve + retainedOutside),
  }
}

export interface SettingsInput {
  distributionPct: number
  capitalSharePct: number
  reservePct: number
  toleranceInr?: number
  adPrepaidBlockDays?: number
  passthroughWarnDays?: number
}

/** Server-side validation; the database CHECKs enforce the same. */
export function validateSettings(s: SettingsInput): string[] {
  const errors: string[] = []
  const pct = (label: string, v: number) => {
    if (!Number.isFinite(v)) errors.push(`${label} must be a number`)
    else if (v < 0 || v > 100) errors.push(`${label} must be between 0 and 100`)
    else if (round2(v) !== v) errors.push(`${label} can have at most 2 decimals`)
  }
  pct('Distribution rate', s.distributionPct)
  pct('Capital Share', s.capitalSharePct)
  pct('Business Reserve', s.reservePct)
  if (Number.isFinite(s.capitalSharePct) && Number.isFinite(s.reservePct)
      && Math.round((s.capitalSharePct + s.reservePct) * 100) !== 10000) {
    errors.push('Capital Share and Business Reserve must total exactly 100%')
  }
  if (s.toleranceInr != null && (!Number.isFinite(s.toleranceInr) || s.toleranceInr < 0)) {
    errors.push('Reconciliation tolerance cannot be negative')
  }
  for (const [label, v] of [['Ad-funding block', s.adPrepaidBlockDays], ['Pass-through warning', s.passthroughWarnDays]] as const) {
    if (v != null && (!Number.isInteger(v) || v <= 0)) errors.push(`${label} must be a whole number of days above 0`)
  }
  return errors
}
