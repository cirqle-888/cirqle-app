import { describe, it, expect } from 'vitest'
import { inPeriod, isPeriod, monthPeriod, periodLabel, recentMonths } from './period'

describe('monthPeriod', () => {
  it('covers a whole month, short ones included', () => {
    expect(monthPeriod('2026-02-14')).toEqual({ start: '2026-02-01', end: '2026-02-28' })
    expect(monthPeriod('2024-02-14')).toEqual({ start: '2024-02-01', end: '2024-02-29' })
    expect(monthPeriod('2026-07-31')).toEqual({ start: '2026-07-01', end: '2026-07-31' })
  })

  it('refuses what is not a date', () => {
    expect(monthPeriod('July 2026')).toBeNull()
    expect(monthPeriod('2026-13-01')).toBeNull()
  })
})

describe('recentMonths', () => {
  it('walks backwards across a year boundary', () => {
    const got = recentMonths('2026-02-10', null, 3)
    expect(got.map(p => p.start)).toEqual(['2026-02-01', '2026-01-01', '2025-12-01'])
  })

  it('stops at the date the account starts being reconciled', () => {
    const got = recentMonths('2026-03-10', '2026-01-15', 12)
    // January is kept — it ENDS after the 15th, so part of it is reconcilable.
    expect(got.map(p => p.start)).toEqual(['2026-03-01', '2026-02-01', '2026-01-01'])
  })
})

describe('periodLabel', () => {
  it('names a whole month as a month', () => {
    expect(periodLabel({ start: '2026-07-01', end: '2026-07-31' })).toBe('July 2026')
    expect(periodLabel({ start: '2026-02-01', end: '2026-02-28' })).toBe('February 2026')
  })

  it('never calls a part-month by the month name', () => {
    expect(periodLabel({ start: '2026-07-03', end: '2026-08-02' })).toBe('3 Jul – 2 Aug 2026')
    expect(periodLabel({ start: '2026-07-01', end: '2026-07-30' })).toBe('1 Jul – 30 Jul 2026')
  })

  it('states both years when the period crosses one', () => {
    expect(periodLabel({ start: '2025-12-20', end: '2026-01-19' })).toBe('20 Dec 2025 – 19 Jan 2026')
  })
})

describe('isPeriod / inPeriod', () => {
  it('rejects a period that ends before it starts', () => {
    expect(isPeriod({ start: '2026-07-31', end: '2026-07-01' })).toBe(false)
    expect(isPeriod({ start: '2026-07-01', end: '2026-07-31' })).toBe(true)
  })

  it('includes both ends', () => {
    const p = { start: '2026-07-01', end: '2026-07-31' }
    expect(inPeriod('2026-07-01', p)).toBe(true)
    expect(inPeriod('2026-07-31', p)).toBe(true)
    expect(inPeriod('2026-08-01', p)).toBe(false)
  })
})
