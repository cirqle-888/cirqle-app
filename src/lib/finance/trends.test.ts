import { describe, it, expect } from 'vitest'
import {
  resolveComparisonPeriods, buildTrendSeries, alignComparison,
  seriesTotals, pctChange, addDays, rangeDays,
} from './trends'

const TODAY = '2026-07-14' // a Tuesday

describe('resolveComparisonPeriods', () => {
  it('week: Monday-start week vs the week before, current clamped to today', () => {
    const p = resolveComparisonPeriods('week', TODAY)
    expect(p.current).toEqual({ from: '2026-07-13', to: '2026-07-14' })
    expect(p.previous).toEqual({ from: '2026-07-06', to: '2026-07-12' })
    expect(p.granularity).toBe('day')
  })

  it('month: calendar month vs previous month, current clamped to today', () => {
    const p = resolveComparisonPeriods('month', TODAY)
    expect(p.current).toEqual({ from: '2026-07-01', to: '2026-07-14' })
    expect(p.previous).toEqual({ from: '2026-06-01', to: '2026-06-30' })
  })

  it('quarter: calendar quarter vs previous quarter, current clamped to today', () => {
    const p = resolveComparisonPeriods('quarter', TODAY)
    expect(p.current).toEqual({ from: '2026-07-01', to: '2026-07-14' })
    expect(p.previous).toEqual({ from: '2026-04-01', to: '2026-06-30' })
  })

  it('year: monthly granularity, this year vs last year, current clamped to today', () => {
    const p = resolveComparisonPeriods('year', TODAY)
    expect(p.current).toEqual({ from: '2026-01-01', to: '2026-07-14' })
    expect(p.previous).toEqual({ from: '2025-01-01', to: '2025-12-31' })
    expect(p.granularity).toBe('month')
  })

  it('current period never extends past today, but previous stays a full historical period', () => {
    // Viewing "Month" mid-month must not plot unrealized future days as a flat
    // carried-forward balance — the dashed previous-period line is unaffected.
    const p = resolveComparisonPeriods('month', TODAY)
    expect(p.current.to).toBe(TODAY)
    expect(p.previous.to).toBe('2026-06-30')
  })

  it('custom: previous = same number of days immediately before, back-to-back', () => {
    const p = resolveComparisonPeriods('custom', TODAY, { from: '2026-07-05', to: '2026-07-14' }) // 10 days
    expect(p.previous).toEqual({ from: '2026-06-25', to: '2026-07-04' })
    expect(rangeDays(p.previous)).toBe(rangeDays(p.current))
    expect(p.granularity).toBe('day')
  })

  it('custom over ~3 months flips to monthly buckets', () => {
    const p = resolveComparisonPeriods('custom', TODAY, { from: '2026-01-01', to: '2026-06-30' })
    expect(p.granularity).toBe('month')
  })

  it('month boundaries handle January → December year rollover', () => {
    const p = resolveComparisonPeriods('month', '2026-01-10')
    expect(p.previous).toEqual({ from: '2025-12-01', to: '2025-12-31' })
  })
})

describe('buildTrendSeries', () => {
  const cash = [
    { date: '2026-06-20', type: 'inflow' as const, amountInr: 10000 },  // before window → opening
    { date: '2026-07-01', type: 'inflow' as const, amountInr: 5000 },
    { date: '2026-07-01', type: 'outflow' as const, amountInr: 2000 },
    { date: '2026-07-03', type: 'outflow' as const, amountInr: 1000 },
    { date: '2026-08-09', type: 'inflow' as const, amountInr: 99999 }, // after window → ignored
  ]
  const tasks = [
    { date: '2026-07-01' }, { date: '2026-07-01' }, { date: '2026-07-03' },
    { date: '2026-06-30' },                                            // outside → ignored
  ]

  it('buckets by day with a running balance seeded from the opening balance', () => {
    const s = buildTrendSeries({ cash, tasks }, { from: '2026-07-01', to: '2026-07-03' }, 'day')
    expect(s).toHaveLength(3)
    expect(s[0]).toMatchObject({ key: '2026-07-01', jobs: 2, inflowInr: 5000, outflowInr: 2000, balanceInr: 13000 })
    expect(s[1]).toMatchObject({ key: '2026-07-02', jobs: 0, inflowInr: 0, outflowInr: 0, balanceInr: 13000 })
    expect(s[2]).toMatchObject({ key: '2026-07-03', jobs: 1, outflowInr: 1000, balanceInr: 12000 })
    expect(s[0].label).toBe('1 Jul')
  })

  it('buckets by month across a year boundary', () => {
    const s = buildTrendSeries(
      { cash: [{ date: '2025-12-15', type: 'inflow', amountInr: 100 }], tasks: [] },
      { from: '2025-11-01', to: '2026-01-31' }, 'month',
    )
    expect(s.map(b => b.key)).toEqual(['2025-11', '2025-12', '2026-01'])
    expect(s[1].inflowInr).toBe(100)
    expect(s[2].balanceInr).toBe(100)   // running carries forward
    expect(s[2].label).toBe('Jan 26')
  })
})

describe('alignComparison', () => {
  it('zips by index and pads the shorter series (31-day vs 30-day month)', () => {
    const cur = buildTrendSeries({ cash: [], tasks: [] }, { from: '2026-07-01', to: '2026-07-31' }, 'day')
    const prev = buildTrendSeries({ cash: [], tasks: [] }, { from: '2026-06-01', to: '2026-06-30' }, 'day')
    const rows = alignComparison(cur, prev)
    expect(rows).toHaveLength(31)
    expect(rows[0].label).toBe('1 Jul')
    expect(rows[0].prevLabel).toBe('1 Jun')
    expect(rows[30].prev_inflowInr).toBeUndefined()   // June has no day 31
    expect(rows[30].inflowInr).toBe(0)
  })
})

describe('seriesTotals / pctChange', () => {
  it('sums flows, takes END balance, computes % change', () => {
    const s = buildTrendSeries({
      cash: [
        { date: '2026-07-01', type: 'inflow', amountInr: 100 },
        { date: '2026-07-02', type: 'inflow', amountInr: 50 },
        { date: '2026-07-02', type: 'outflow', amountInr: 30 },
      ],
      tasks: [{ date: '2026-07-01' }],
    }, { from: '2026-07-01', to: '2026-07-02' }, 'day')
    const t = seriesTotals(s)
    expect(t).toEqual({ jobs: 1, inflowInr: 150, outflowInr: 30, endBalanceInr: 120 })
    expect(pctChange(150, 100)).toBe(50)
    expect(pctChange(50, 100)).toBe(-50)
    expect(pctChange(10, 0)).toBeNull()
    expect(pctChange(10, undefined)).toBeNull()
  })
})

describe('addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
  })
})
