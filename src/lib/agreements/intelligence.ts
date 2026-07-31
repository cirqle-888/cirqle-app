/**
 * Operational intelligence (Phase 4) — READ ONLY, no new schema.
 *
 * Composes signals the analytics engine already produced into a client health
 * score and rule-based business insights. No new business metric is computed
 * from raw data here — every input is an existing analytics field.
 */

import type { RetainerAnalytics, RetainerTrendPoint } from './analytics'

// ─── Client / agreement health score ─────────────────────────────────────────

export type HealthBand = 'excellent' | 'healthy' | 'watch' | 'at_risk' | 'critical'

export interface HealthWeights {
  utilisation: number
  margin: number
  renewal: number
  coverage: number
}
export const DEFAULT_HEALTH_WEIGHTS: HealthWeights = { utilisation: 0.30, margin: 0.35, renewal: 0.20, coverage: 0.15 }

export interface HealthResult {
  score: number            // 0–100
  band: HealthBand
  factors: { label: string; score: number; weight: number }[]
}

function bandFor(score: number): HealthBand {
  if (score >= 85) return 'excellent'
  if (score >= 70) return 'healthy'
  if (score >= 50) return 'watch'
  if (score >= 30) return 'at_risk'
  return 'critical'
}

export const HEALTH_LABEL: Record<HealthBand, string> = {
  excellent: 'Excellent', healthy: 'Healthy', watch: 'Watch', at_risk: 'At risk', critical: 'Critical',
}
export const HEALTH_COLOR: Record<HealthBand, string> = {
  excellent: 'text-emerald-600 dark:text-emerald-400',
  healthy: 'text-emerald-600 dark:text-emerald-400',
  watch: 'text-amber-600 dark:text-amber-400',
  at_risk: 'text-orange-600 dark:text-orange-400',
  critical: 'text-red-600 dark:text-red-400',
}

function monthsToExpiry(month: string, end: string | null): number | null {
  if (!end) return null
  const [y, m] = month.split('-').map(Number)
  const [ey, em] = end.split('-').map(Number)
  return (ey - y) * 12 + (em - m)
}

/**
 * Composite health for one retainer. Weights renormalize over whichever factors
 * are available (margin drops out for non-pricing viewers), so the score is
 * always on 0–100. `weights` is overridable (Settings will drive it later).
 */
export function agreementHealthScore(
  a: RetainerAnalytics,
  month: string,
  weights: HealthWeights = DEFAULT_HEALTH_WEIGHTS,
): HealthResult {
  const factors: { label: string; score: number; weight: number }[] = []

  // Utilisation: ideal band 60–100%; under- and over-use both cost health.
  const u = a.utilisation
  const utilScore = u > 100 ? Math.max(0, 100 - (u - 100) * 1.5)
    : u >= 60 ? 100
    : u >= 40 ? 70
    : u >= 20 ? 45
    : 25
  factors.push({ label: 'Utilisation', score: Math.round(utilScore), weight: weights.utilisation })

  // Margin (profitability) — only when we can see money.
  if (a.marginPct != null) {
    const mp = a.marginPct
    const marginScore = mp >= 40 ? 100 : mp >= 25 ? 85 : mp >= 15 ? 65 : mp >= 0 ? 40 : 0
    factors.push({ label: 'Profitability', score: marginScore, weight: weights.margin })
  }

  // Renewal risk from expiry proximity.
  const mm = monthsToExpiry(month, a.endDate)
  const renewalScore = mm == null ? 100 : mm <= 0 ? 0 : mm >= 3 ? 100 : Math.round((mm / 3) * 100)
  factors.push({ label: 'Renewal', score: renewalScore, weight: weights.renewal })

  // Coverage/agreement health.
  const covScore = a.coverageHealth === 'green' ? 100 : a.coverageHealth === 'amber' ? 60 : 30
  factors.push({ label: 'Agreement health', score: covScore, weight: weights.coverage })

  const totalW = factors.reduce((s, f) => s + f.weight, 0) || 1
  const score = Math.round(factors.reduce((s, f) => s + f.score * f.weight, 0) / totalW)
  return { score, band: bandFor(score), factors }
}

// ─── Smart insights ──────────────────────────────────────────────────────────

export type InsightPriority = 'high' | 'medium' | 'low'
export interface Insight {
  key: string
  agreementId?: string
  title: string
  reason: string
  recommendation: string
  priority: InsightPriority
  pricing?: boolean   // reveals money; hide from non-pricing viewers
}

/**
 * Rule-based operational insights over the analytics rows + trend. Each insight
 * cites the existing figure that triggered it and a recommended action. Money-
 * bearing insights are flagged so callers can hide them from non-pricing users.
 */
export function smartInsights(
  rows: RetainerAnalytics[],
  trend: RetainerTrendPoint[],
  month: string,
): Insight[] {
  const out: Insight[] = []

  for (const a of rows) {
    const mm = monthsToExpiry(month, a.endDate)
    if (mm != null && mm >= 0 && mm <= 1) {
      out.push({ key: `expiry:${a.agreementId}`, agreementId: a.agreementId, priority: 'high',
        title: `${a.clientName} — renewal due`,
        reason: `${a.agreementNumber} expires ${a.endDate}.`,
        recommendation: 'Start the renewal conversation and confirm scope for next term.' })
    }
    if (a.utilisation > 100 || a.extraTasks > 0) {
      out.push({ key: `over:${a.agreementId}`, agreementId: a.agreementId, priority: 'medium',
        title: `${a.clientName} — exceeding allocation`,
        reason: `Utilisation ${a.utilisation}%${a.extraTasks ? `, ${a.extraTasks} extra task(s)` : ''}.`,
        recommendation: 'Bill extra work or discuss upgrading the retainer.' })
    } else if (a.utilisation < 40 && a.included > 0) {
      out.push({ key: `under:${a.agreementId}`, agreementId: a.agreementId, priority: 'low',
        title: `${a.clientName} — under-utilising retainer`,
        reason: `Only ${a.delivered}/${a.included} delivered (${a.utilisation}%).`,
        recommendation: 'Schedule content or check in — low usage risks churn at renewal.' })
    }
    if (a.marginPct != null && a.marginPct < 0) {
      out.push({ key: `loss:${a.agreementId}`, agreementId: a.agreementId, priority: 'high', pricing: true,
        title: `${a.clientName} — loss-making retainer`,
        reason: `Margin ${a.marginPct}% (internal cost above creative allocation).`,
        recommendation: 'Review allocation/staffing or re-price at renewal.' })
    } else if (a.marginPct != null && a.marginPct < 15) {
      out.push({ key: `thin:${a.agreementId}`, agreementId: a.agreementId, priority: 'medium', pricing: true,
        title: `${a.clientName} — thin margin`,
        reason: `Margin ${a.marginPct}%.`,
        recommendation: 'Watch internal cost; consider efficiency or re-pricing.' })
    }
  }

  // Macro trend insight (revenue direction) from the trend series.
  const sig = trend.filter(t => (t.revenue ?? 0) > 0)
  if (sig.length >= 3) {
    const first = sig[0].revenue ?? 0, last = sig[sig.length - 1].revenue ?? 0
    if (first > 0) {
      const change = Math.round(((last - first) / first) * 100)
      if (change <= -10) out.push({ key: 'rev-down', priority: 'high', pricing: true,
        title: 'Retainer revenue declining', reason: `Down ${Math.abs(change)}% over ${sig.length} months.`,
        recommendation: 'Investigate churn/downgrades and prioritise renewals.' })
      else if (change >= 15) out.push({ key: 'rev-up', priority: 'low', pricing: true,
        title: 'Retainer revenue growing', reason: `Up ${change}% over ${sig.length} months.`,
        recommendation: 'Ensure delivery capacity keeps pace with growth.' })
    }
  }

  const order: Record<InsightPriority, number> = { high: 0, medium: 1, low: 2 }
  return out.sort((a, b) => order[a.priority] - order[b.priority])
}
