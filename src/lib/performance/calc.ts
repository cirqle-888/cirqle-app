import type { PerfCriterion, PerfBreakdownGroup } from './types'

/**
 * Normalize one raw score to 0–100 based on the criterion's unit.
 *
 *  percent → raw is already 0–100
 *  level   → 1–5 scale → ×20
 *  years   → raw years vs target years (capped at 100; diminishing value
 *            beyond the target is intentional — year 9 of 8 adds nothing)
 *  time    → actual minutes vs target minutes; FASTER IS BETTER
 *            (target 60, took 30 → 100; took 120 → 50)
 *  count   → raw count vs target count (capped at 100)
 */
export function normalizeScore(c: Pick<PerfCriterion, 'unit' | 'target'>, raw: number): number {
  if (!Number.isFinite(raw)) return 0
  switch (c.unit) {
    case 'percent': return clamp(raw)
    case 'level':   return clamp(raw * 20)
    case 'years':   return clamp((raw / (c.target || 8)) * 100)
    case 'time':    return raw <= 0 ? 0 : clamp(((c.target || 60) / raw) * 100)
    case 'count':   return clamp((raw / (c.target || 10)) * 100)
    default:        return clamp(raw)
  }
}

const clamp = (n: number) => Math.max(0, Math.min(100, n))

export interface CalcResult {
  final: number | null
  groups: PerfBreakdownGroup[]
}

/**
 * Weighted roll-up. Only SCORED sub-parameters count (unscored ones are
 * skipped, weights re-normalized), so a half-filled draft still shows an
 * honest live number. Groups with nothing scored are excluded the same way.
 */
export function calcAssessment(
  criteria: PerfCriterion[],
  scores: Map<string, number>,   // criteria_id → raw value
): CalcResult {
  const groups = criteria.filter(c => !c.parent_id && c.is_active).sort((a, b) => a.sort - b.sort)
  const out: PerfBreakdownGroup[] = []
  let weightedSum = 0
  let weightTotal = 0

  for (const g of groups) {
    const subs = criteria.filter(c => c.parent_id === g.id && c.is_active)
    let sSum = 0, sW = 0
    for (const s of subs) {
      const raw = scores.get(s.id)
      if (raw == null) continue
      const w = Math.max(0, s.weight)
      sSum += normalizeScore(s, raw) * w
      sW += w
    }
    const score = sW > 0 ? sSum / sW : null
    out.push({ group_id: g.id, name: g.name, weight: g.weight, score: score == null ? null : round2(score) })
    if (score != null) {
      const w = Math.max(0, g.weight)
      weightedSum += score * w
      weightTotal += w
    }
  }

  return { final: weightTotal > 0 ? round2(weightedSum / weightTotal) : null, groups: out }
}

// Canonical money rounding — a local Math.round(n * 100) / 100 disagrees at
// the .xx5 midpoints (1.005 -> 1.00 instead of 1.01). See currency.ts round2.
import { round2 } from '@/lib/calculations/currency'
