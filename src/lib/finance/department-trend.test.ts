import { describe, it, expect } from 'vitest'
import {
  buildDepartmentTrend, buildMix, growthPct,
  type DepartmentMonthPoint,
} from './department-trend'

const pt = (
  month: string,
  revenueInr: number,
  directLabourInr = 0,
  taskCount = 1,
): DepartmentMonthPoint => ({ month, revenueInr, directLabourInr, taskCount })

describe('growthPct', () => {
  it('computes ordinary growth and decline', () => {
    expect(growthPct(150, 100)).toBe(50)
    expect(growthPct(75, 100)).toBe(-25)
    expect(growthPct(100, 100)).toBe(0)
  })

  it('is NULL from a zero base — a first month is a start, not infinite growth', () => {
    expect(growthPct(5_000, 0)).toBeNull()
  })

  it('is NULL from a negative base — the sign flip makes the ratio meaningless', () => {
    expect(growthPct(100, -50)).toBeNull()
  })

  it('is null on non-finite input rather than NaN', () => {
    expect(growthPct(NaN, 100)).toBeNull()
    expect(growthPct(100, Infinity)).toBeNull()
  })
})

describe('buildDepartmentTrend', () => {
  it('derives margin, margin % and average ticket per month', () => {
    const { rows } = buildDepartmentTrend([pt('2026-01', 10_000, 4_000, 5)])
    expect(rows[0].contributionMarginInr).toBe(6_000)
    expect(rows[0].contributionMarginPct).toBe(60)
    expect(rows[0].avgTicketInr).toBe(2_000)
  })

  it('leaves the first month with no growth figure', () => {
    const { rows } = buildDepartmentTrend([pt('2026-01', 10_000), pt('2026-02', 12_000)])
    expect(rows[0].revenueGrowthPct).toBeNull()
    expect(rows[1].revenueGrowthPct).toBe(20)
  })

  it('flags a start after a dormant month instead of reporting a growth %', () => {
    const { rows } = buildDepartmentTrend([pt('2026-01', 0, 0, 0), pt('2026-02', 8_000)])
    expect(rows[1].revenueGrowthPct).toBeNull()
    expect(rows[1].isNewStart).toBe(true)
  })

  it('indexes revenue against the first ACTIVE month', () => {
    const { rows } = buildDepartmentTrend([
      pt('2026-01', 0, 0, 0), pt('2026-02', 1_000), pt('2026-03', 1_500),
    ])
    expect(rows[0].indexVsStart).toBeNull()   // before any activity
    expect(rows[1].indexVsStart).toBe(100)
    expect(rows[2].indexVsStart).toBe(150)
  })

  it('averages only the DEFINED growth rates', () => {
    // Jan→Feb undefined (zero base). Feb→Mar +100%. Mar→Apr −50%.
    // Mean of the two defined = +25%, not 25/3.
    const t = buildDepartmentTrend([
      pt('2026-01', 0, 0, 0), pt('2026-02', 1_000), pt('2026-03', 2_000), pt('2026-04', 1_000),
    ])
    expect(t.avgMonthlyGrowthPct).toBe(25)
  })

  it('is null for average growth when no month has a usable base', () => {
    expect(buildDepartmentTrend([pt('2026-01', 5_000)]).avgMonthlyGrowthPct).toBeNull()
  })

  it('half-over-half resists a single spike that skews the mean', () => {
    // A 20x spike in month 2 makes mean MoM growth wildly positive even though
    // the later half is flat and small.
    const t = buildDepartmentTrend([
      pt('2026-01', 100), pt('2026-02', 2_000), pt('2026-03', 100), pt('2026-04', 100),
    ])
    // Early half mean = (100 + 2000)/2 = 1050; late half = 100.
    expect(t.halfOverHalfPct).toBeCloseTo(-90.5, 1)
    expect(t.avgMonthlyGrowthPct!).toBeGreaterThan(0)  // the mean disagrees — that IS the finding
  })

  it('gives the later half the middle month on an odd count', () => {
    const t = buildDepartmentTrend([pt('2026-01', 100), pt('2026-02', 200), pt('2026-03', 300)])
    // early = [100] (mean 100), late = [200, 300] (mean 250) → +150%
    expect(t.halfOverHalfPct).toBe(150)
  })

  it('is null for half-over-half when the earlier half earned nothing', () => {
    const t = buildDepartmentTrend([pt('2026-01', 0, 0, 0), pt('2026-02', 500)])
    expect(t.halfOverHalfPct).toBeNull()
  })

  it('reports best and worst among ACTIVE months only', () => {
    const t = buildDepartmentTrend([
      pt('2026-01', 5_000), pt('2026-02', 0, 0, 0), pt('2026-03', 9_000), pt('2026-04', 1_000),
    ])
    expect(t.bestMonth!.month).toBe('2026-03')
    expect(t.worstMonth!.month).toBe('2026-04')   // the dormant month is not "worst"
    expect(t.activeMonths).toBe(3)
  })

  it('totals revenue, labour, margin and tasks', () => {
    const t = buildDepartmentTrend([pt('2026-01', 10_000, 4_000, 2), pt('2026-02', 6_000, 1_000, 3)])
    expect(t.totalRevenueInr).toBe(16_000)
    expect(t.totalLabourInr).toBe(5_000)
    expect(t.totalMarginInr).toBe(11_000)
    expect(t.totalTaskCount).toBe(5)
    expect(t.marginPct).toBe(68.8)
  })

  it('exposes the latest move separately from the average', () => {
    const t = buildDepartmentTrend([pt('2026-01', 100), pt('2026-02', 200), pt('2026-03', 100)])
    expect(t.latestGrowthPct).toBe(-50)
  })

  it('sorts unordered input by month', () => {
    const t = buildDepartmentTrend([pt('2026-03', 300), pt('2026-01', 100), pt('2026-02', 200)])
    expect(t.rows.map(r => r.month)).toEqual(['2026-01', '2026-02', '2026-03'])
  })

  it('handles an empty window without dividing by zero', () => {
    const t = buildDepartmentTrend([])
    expect(t.rows).toEqual([])
    expect(t.marginPct).toBe(0)
    expect(t.avgMonthlyGrowthPct).toBeNull()
    expect(t.halfOverHalfPct).toBeNull()
    expect(t.bestMonth).toBeNull()
    expect(t.latestGrowthPct).toBeNull()
  })

  it('does not divide by zero on a month with revenue but no tasks', () => {
    const { rows } = buildDepartmentTrend([pt('2026-01', 5_000, 0, 0)])
    expect(rows[0].avgTicketInr).toBe(0)
  })
})

describe('buildMix', () => {
  const m = (id: string, revenueInr: number, taskCount = 1) =>
    ({ id, label: id, revenueInr, taskCount })

  it('ranks by revenue with shares that total 100', () => {
    const rows = buildMix([m('a', 6_000), m('b', 3_000), m('c', 1_000)])
    expect(rows.map(r => r.id)).toEqual(['a', 'b', 'c'])
    expect(rows[0].sharePct).toBe(60)
    expect(rows.reduce((s, r) => s + r.sharePct, 0)).toBeCloseTo(100, 6)
  })

  it('merges repeated ids', () => {
    const rows = buildMix([m('a', 1_000, 2), m('a', 500, 3)])
    expect(rows).toHaveLength(1)
    expect(rows[0].revenueInr).toBe(1_500)
    expect(rows[0].taskCount).toBe(5)
  })

  it('never lets a negative line push another share past 100', () => {
    const rows = buildMix([m('a', 1_000), m('refund', -400)])
    expect(rows.find(r => r.id === 'a')!.sharePct).toBe(100)
    expect(rows.find(r => r.id === 'refund')!.sharePct).toBe(0)
  })

  it('handles an empty list and an all-zero list', () => {
    expect(buildMix([])).toEqual([])
    expect(buildMix([m('a', 0)])[0].sharePct).toBe(0)
  })
})
