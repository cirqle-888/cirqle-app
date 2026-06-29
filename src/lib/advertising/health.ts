/**
 * Advertising — campaign health score (pure, unit-tested).
 *
 * A 0–100 score blending the signals we have. Each signal contributes only when
 * its inputs are present, and the weights renormalize over whatever is
 * available, so a brand-new campaign with no metrics still returns a sane
 * neutral score rather than 0. v1 is intentionally simple; thresholds can be
 * tuned later without changing call sites.
 */

export interface HealthInput {
  adBudget?: number | null
  totalSpend?: number | null
  startDate?: string | null
  endDate?: string | null
  /** Campaign-level ROAS (revenue / spend), as a multiple. */
  roas?: number | null
  /** Campaign-level CTR, as a percentage. */
  ctr?: number | null
  status?: string | null
  /** Override "today" for deterministic tests. */
  asOf?: Date | string
}

export interface HealthResult {
  score: number
  label: 'Excellent' | 'Good' | 'Fair' | 'Poor' | 'Unknown'
  factors: { key: string; score: number; weight: number }[]
}

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v))

function toDate(d?: Date | string | null): Date | null {
  if (!d) return null
  const x = d instanceof Date ? d : new Date(d)
  return Number.isNaN(x.getTime()) ? null : x
}

/** ROAS → 0..100: 0 at 0×, 100 at ≥4×, linear between. */
function roasScore(roas: number): number {
  return clamp((roas / 4) * 100)
}

/** CTR(%) → 0..100: 0 at 0%, 100 at ≥2%, linear between. */
function ctrScore(ctr: number): number {
  return clamp((ctr / 2) * 100)
}

/**
 * Pacing → 0..100. Compares actual spend fraction to the fraction of the
 * flight that has elapsed; closest to on-pace scores highest. Big overspend or
 * a stalled (no-spend) active campaign both score low.
 */
function pacingScore(input: HealthInput): number | null {
  const start = toDate(input.startDate)
  const end = toDate(input.endDate)
  const budget = Number(input.adBudget || 0)
  const spent = Number(input.totalSpend || 0)
  if (!start || !end || budget <= 0 || end <= start) return null

  const now = toDate(input.asOf) ?? new Date()
  const total = end.getTime() - start.getTime()
  const elapsed = clamp(((now.getTime() - start.getTime()) / total) * 100) / 100
  if (elapsed <= 0) return 100 // not started yet — nothing to pace against

  const spendFrac = spent / budget
  // Penalize the gap between how much time has passed and how much was spent.
  const gap = Math.abs(spendFrac - elapsed)
  return clamp(100 - gap * 100)
}

/** Budget discipline → 0..100. 100 while within budget, falls off on overspend. */
function budgetScore(input: HealthInput): number | null {
  const budget = Number(input.adBudget || 0)
  if (budget <= 0) return null
  const spent = Number(input.totalSpend || 0)
  const over = spent / budget
  if (over <= 1) return 100
  return clamp(100 - (over - 1) * 200) // 10% over → 80, 50% over → 0
}

export function healthScore(input: HealthInput): HealthResult {
  const factors: { key: string; score: number; weight: number }[] = []
  const add = (key: string, score: number | null, weight: number) => {
    if (score != null) factors.push({ key, score: clamp(score), weight })
  }

  add('roas', input.roas != null ? roasScore(input.roas) : null, 0.4)
  add('ctr', input.ctr != null ? ctrScore(input.ctr) : null, 0.25)
  add('pacing', pacingScore(input), 0.2)
  add('budget', budgetScore(input), 0.15)

  if (factors.length === 0) {
    return { score: 50, label: 'Unknown', factors }
  }

  const totalWeight = factors.reduce((t, f) => t + f.weight, 0)
  const score = Math.round(
    factors.reduce((t, f) => t + f.score * f.weight, 0) / totalWeight,
  )

  const label: HealthResult['label'] =
    score >= 80 ? 'Excellent' : score >= 60 ? 'Good' : score >= 40 ? 'Fair' : 'Poor'

  return { score, label, factors }
}
