import { describe, it, expect } from 'vitest'
import {
  formatRangeLabel, isMonthEnd, monthOverlapFraction, resolveReportRange, toProfitMonths,
} from './report-range'

// 14 Aug 2026, 20:00 UTC = 15 Aug 2026, 01:30 IST. The business calendar must
// say August either way; the pre-fix `toISOString()` code would say the 14th.
const LATE_NIGHT_IST = new Date('2026-08-14T20:00:00Z')
const MIDDAY = new Date('2026-08-14T06:30:00Z')

describe('resolveReportRange — presets', () => {
  it('defaults to a 6-month window ending this month', () => {
    const r = resolveReportRange({}, MIDDAY)
    expect(r.from).toBe('2026-03-01')
    expect(r.to).toBe('2026-08-31')
    expect(r.months).toEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'])
    expect(r.monthAligned).toBe(true)
    expect(r.presetMonths).toBe(6)
  })

  it('counts the current month as one of the N', () => {
    const r = resolveReportRange({ months: '1' }, MIDDAY)
    expect(r.from).toBe('2026-08-01')
    expect(r.to).toBe('2026-08-31')
    expect(r.months).toEqual(['2026-08'])
  })

  it('resolves on the India calendar after IST midnight, not UTC', () => {
    // 01:30 IST on 15 Aug. A UTC-derived "today" would still be 14 Aug — same
    // month here, so assert the boundary case that actually differs: a preset
    // computed at 01:30 IST on the 1st must not fall back a month.
    const firstOfMonthIst = new Date('2026-08-31T20:00:00Z')  // 1 Sep, 01:30 IST
    const r = resolveReportRange({ months: '1' }, firstOfMonthIst)
    expect(r.from).toBe('2026-09-01')
    expect(r.to).toBe('2026-09-30')
  })

  it('clamps an absurd preset instead of rejecting it', () => {
    expect(resolveReportRange({ months: '999' }, MIDDAY).presetMonths).toBe(24)
    expect(resolveReportRange({ months: '0' }, MIDDAY).presetMonths).toBe(1)
    expect(resolveReportRange({ months: '-5' }, MIDDAY).presetMonths).toBe(1)
  })

  it('falls back to the default on junk rather than throwing', () => {
    expect(resolveReportRange({ months: 'abc' }, MIDDAY).presetMonths).toBe(6)
  })

  it('crosses a year boundary correctly', () => {
    const r = resolveReportRange({ months: '3' }, new Date('2026-01-20T06:30:00Z'))
    expect(r.from).toBe('2025-11-01')
    expect(r.to).toBe('2026-01-31')
    expect(r.months).toEqual(['2025-11', '2025-12', '2026-01'])
  })
})

describe('resolveReportRange — custom', () => {
  it('accepts a custom range and marks a month-aligned one as reconcilable', () => {
    const r = resolveReportRange({ from: '2026-04-01', to: '2026-06-30' }, MIDDAY)
    expect(r.monthAligned).toBe(true)
    expect(r.months).toEqual(['2026-04', '2026-05', '2026-06'])
    expect(r.presetMonths).toBeNull()
  })

  it('marks a part-month range as NOT reconcilable and lists no months', () => {
    // A month's profit snapshot is indivisible, so half a month cannot tie out.
    const r = resolveReportRange({ from: '2026-04-10', to: '2026-06-15' }, MIDDAY)
    expect(r.monthAligned).toBe(false)
    expect(r.months).toEqual([])
    expect(r.from).toBe('2026-04-10')
    expect(r.to).toBe('2026-06-15')
  })

  it('treats a range ending on a short month end as aligned', () => {
    expect(resolveReportRange({ from: '2026-02-01', to: '2026-02-28' }, MIDDAY).monthAligned).toBe(true)
  })

  it('handles a single-day range', () => {
    const r = resolveReportRange({ from: '2026-05-07', to: '2026-05-07' }, MIDDAY)
    expect(r.from).toBe('2026-05-07')
    expect(r.monthAligned).toBe(false)
  })

  it('ignores a reversed or malformed range and uses the preset', () => {
    expect(resolveReportRange({ from: '2026-06-30', to: '2026-04-01' }, MIDDAY).presetMonths).toBe(6)
    expect(resolveReportRange({ from: 'yesterday', to: '2026-04-01' }, MIDDAY).presetMonths).toBe(6)
    expect(resolveReportRange({ from: '2026-13-45', to: '2026-14-99' }, MIDDAY).presetMonths).toBe(6)
  })

  it('prefers a usable custom range over a preset when both are given', () => {
    const r = resolveReportRange({ months: '12', from: '2026-04-01', to: '2026-04-30' }, MIDDAY)
    expect(r.presetMonths).toBeNull()
    expect(r.months).toEqual(['2026-04'])
  })
})

describe('isMonthEnd', () => {
  it('knows month lengths including a leap February', () => {
    expect(isMonthEnd('2026-01-31')).toBe(true)
    expect(isMonthEnd('2026-02-28')).toBe(true)
    expect(isMonthEnd('2024-02-29')).toBe(true)   // leap year
    expect(isMonthEnd('2026-02-27')).toBe(false)
    expect(isMonthEnd('2026-04-30')).toBe(true)
    expect(isMonthEnd('2026-04-29')).toBe(false)
  })
})

describe('monthOverlapFraction', () => {
  it('is 1 for a fully covered month', () => {
    expect(monthOverlapFraction(5, 2026, '2026-04-01', '2026-06-30')).toBe(1)
  })

  it('is 0 for a month outside the range', () => {
    expect(monthOverlapFraction(1, 2026, '2026-04-01', '2026-06-30')).toBe(0)
    expect(monthOverlapFraction(12, 2026, '2026-04-01', '2026-06-30')).toBe(0)
  })

  it('pro-rates a partial leading and trailing month', () => {
    // 16–30 April = 15 of 30 days.
    expect(monthOverlapFraction(4, 2026, '2026-04-16', '2026-06-30')).toBeCloseTo(0.5, 6)
    // 1–15 June = 15 of 30 days.
    expect(monthOverlapFraction(6, 2026, '2026-04-01', '2026-06-15')).toBeCloseTo(0.5, 6)
  })

  it('handles a range inside a single month', () => {
    expect(monthOverlapFraction(8, 2026, '2026-08-01', '2026-08-31')).toBe(1)
    expect(monthOverlapFraction(8, 2026, '2026-08-10', '2026-08-10')).toBeCloseTo(1 / 31, 6)
  })
})

describe('toProfitMonths', () => {
  it('converts YYYY-MM keys to the profit engine shape', () => {
    expect(toProfitMonths(['2025-12', '2026-01'])).toEqual([
      { month: 12, year: 2025 }, { month: 1, year: 2026 },
    ])
  })
})

describe('formatRangeLabel', () => {
  it('renders both ends without timezone drift', () => {
    const label = formatRangeLabel(resolveReportRange({ from: '2026-03-01', to: '2026-08-31' }, MIDDAY))
    expect(label).toContain('1 Mar 2026')
    expect(label).toContain('31 Aug 2026')
  })

  it('is stable regardless of when it is called', () => {
    const r = resolveReportRange({ from: '2026-01-01', to: '2026-01-31' }, LATE_NIGHT_IST)
    expect(formatRangeLabel(r)).toContain('1 Jan 2026')
  })
})
