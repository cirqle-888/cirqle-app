/**
 * Dashboard — departments, this period vs the previous one (pure).
 *
 * The Departments card's numbers come from departmentFlows(); this runs it for
 * two windows and lines the departments up, so each side is exactly what the
 * card shows for that window on its own. Nothing is recomputed differently.
 *
 * PERIOD-TO-DATE by default, like the Business Trends graph: 11 days into
 * November compares with 1–11 October, not all of October — a part period
 * next to a whole one always looks like a collapse. The full previous period
 * is available too, and labelled as such by the caller.
 *
 * Percent change follows department-trend.ts: undefined (null) when the
 * previous figure is 0 — a department's first rupee is a start, not ∞% — or
 * negative, where the sign flip makes the ratio meaningless. The ₹ change is
 * always given.
 */

import { departmentFlows, UNASSIGNED_DEPT, type DeptDayFact, type DeptFlowRow } from './department-flows'
import { addDays, rangeDays, type PeriodRange } from './trends'

export type CompareMetric = 'jobs' | 'jobValueInr' | 'billedInr' | 'inflowInr' | 'outflowInr' | 'netInr'

export const COMPARE_METRICS: readonly CompareMetric[] = ['jobs', 'jobValueInr', 'billedInr', 'inflowInr', 'outflowInr', 'netInr']

export interface MetricChange {
  current: number
  previous: number
  /** current − previous. */
  delta: number
  /** % change, 1 decimal. Null when previous ≤ 0 (see the module note). */
  pct: number | null
}

export interface DeptCompareRow {
  deptId: string
  metrics: Record<CompareMetric, MetricChange>
}

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100

export function change(current: number, previous: number): MetricChange {
  return {
    current: r2(current),
    previous: r2(previous),
    delta: r2(current - previous),
    pct: previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null,
  }
}

/**
 * The previous window to compare with. Period-to-date cuts it to as many days
 * as the current window has had so far (never past its own end): Nov 1–11 →
 * Oct 1–11; a week on Wednesday → last Mon–Wed.
 */
export function previousWindow(current: PeriodRange, previous: PeriodRange, toDate: boolean): PeriodRange {
  if (!toDate) return previous
  const end = addDays(previous.from, rangeDays(current) - 1)
  return { from: previous.from, to: end < previous.to ? end : previous.to }
}

const ZERO: Omit<DeptFlowRow, 'deptId'> = {
  jobs: 0, jobValueInr: 0, billedInr: 0, inflowInr: 0, contributionPayInr: 0, sharedCostInr: 0, outflowInr: 0, netInr: 0,
}

/**
 * Every department active in either window, current vs previous. Each window
 * shares out ITS OWN operating outflow — pass the dashboard's outflow for each.
 * Ordered like the card: by current revenue, then previous, Unassigned last.
 */
export function departmentComparison(
  facts: readonly DeptDayFact[],
  current: { window: PeriodRange; outflowInr: number },
  previous: { window: PeriodRange; outflowInr: number },
): { rows: DeptCompareRow[]; total: Record<CompareMetric, MetricChange> } {
  const cur = new Map(departmentFlows(facts, current.window, current.outflowInr).map(r => [r.deptId, r]))
  const prev = new Map(departmentFlows(facts, previous.window, previous.outflowInr).map(r => [r.deptId, r]))
  const ids = [...new Set([...cur.keys(), ...prev.keys()])]

  const rows = ids.map(deptId => {
    const c = cur.get(deptId) ?? { deptId, ...ZERO }
    const p = prev.get(deptId) ?? { deptId, ...ZERO }
    return {
      deptId,
      metrics: Object.fromEntries(COMPARE_METRICS.map(m => [m, change(c[m], p[m])])) as Record<CompareMetric, MetricChange>,
    }
  })
  rows.sort((a, b) => {
    if (a.deptId === UNASSIGNED_DEPT) return 1
    if (b.deptId === UNASSIGNED_DEPT) return -1
    return b.metrics.billedInr.current - a.metrics.billedInr.current
      || b.metrics.billedInr.previous - a.metrics.billedInr.previous
      || b.metrics.jobValueInr.current - a.metrics.jobValueInr.current
  })

  const total = Object.fromEntries(COMPARE_METRICS.map(m => [m, change(
    rows.reduce((s, r) => s + r.metrics[m].current, 0),
    rows.reduce((s, r) => s + r.metrics[m].previous, 0),
  )])) as Record<CompareMetric, MetricChange>

  return { rows, total }
}
