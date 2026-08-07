import { describe, it, expect } from 'vitest'
import {
  monthPeriod, quarterPeriod, yearPeriod, endOfMonth, monthsInPeriod,
  periodForBookingMonth, activeForPeriod,
} from './periods'

describe('endOfMonth', () => {
  it.each([
    [2026, 1, '2026-01-31'], [2026, 2, '2026-02-28'], [2024, 2, '2024-02-29'], [2026, 4, '2026-04-30'],
  ])('%d-%d → %s', (y, m, expected) => expect(endOfMonth(y, m)).toBe(expected))
})

describe('period shapes', () => {
  it('a month books into itself', () => {
    expect(monthPeriod(2026, 7)).toEqual({
      start: '2026-07-01', end: '2026-07-31', bookedMonth: 7, bookedYear: 2026, label: 'July 2026',
    })
  })

  it('a quarter books into its CLOSING month', () => {
    // Paid with September's salary, not July's — the intuitive reading.
    expect(quarterPeriod(2026, 3)).toEqual({
      start: '2026-07-01', end: '2026-09-30', bookedMonth: 9, bookedYear: 2026, label: 'Q3 2026',
    })
  })

  it('a year books into December', () => {
    expect(yearPeriod(2026)).toMatchObject({ start: '2026-01-01', end: '2026-12-31', bookedMonth: 12 })
  })
})

describe('monthsInPeriod', () => {
  it('expands a quarter to its three months — how quarterly profit is summed', () => {
    expect(monthsInPeriod(quarterPeriod(2026, 3))).toEqual([
      { month: 7, year: 2026 }, { month: 8, year: 2026 }, { month: 9, year: 2026 },
    ])
  })

  it('expands a year to twelve months', () => {
    expect(monthsInPeriod(yearPeriod(2026))).toHaveLength(12)
  })

  it('handles a single month', () => {
    expect(monthsInPeriod(monthPeriod(2026, 7))).toEqual([{ month: 7, year: 2026 }])
  })
})

describe('periodForBookingMonth — when a program actually pays', () => {
  it('monthly pays every month', () => {
    expect(periodForBookingMonth('monthly', 5, 2026)?.label).toBe('May 2026')
  })

  it('quarterly pays ONLY in the closing month — not three times a quarter', () => {
    expect(periodForBookingMonth('quarterly', 7, 2026)).toBeNull()
    expect(periodForBookingMonth('quarterly', 8, 2026)).toBeNull()
    expect(periodForBookingMonth('quarterly', 9, 2026)?.label).toBe('Q3 2026')
  })

  it('yearly pays only in December', () => {
    expect(periodForBookingMonth('yearly', 11, 2026)).toBeNull()
    expect(periodForBookingMonth('yearly', 12, 2026)?.label).toBe('2026')
  })

  it('a one-off pays once, in the month its window closes', () => {
    const w = { start: '2026-10-01', end: '2026-11-15' }
    expect(periodForBookingMonth('one_time', 10, 2026, w)).toBeNull()
    expect(periodForBookingMonth('one_time', 11, 2026, w)).toMatchObject({ start: '2026-10-01', end: '2026-11-15' })
    expect(periodForBookingMonth('one_time', 12, 2026, w)).toBeNull()
  })

  it('a one-off with no window never pays', () => {
    expect(periodForBookingMonth('one_time', 11, 2026, { start: null, end: null })).toBeNull()
  })
})

describe('activeForPeriod — judged on the period END', () => {
  const p = monthPeriod(2026, 7)

  it('is live for an open-ended record that started earlier', () => {
    expect(activeForPeriod('2026-01-01', null, p)).toBe(true)
  })

  it('is not live before it starts', () => {
    expect(activeForPeriod('2026-08-01', null, p)).toBe(false)
  })

  it('does NOT pay for a period it ended part-way through', () => {
    // No pro-rating in v1: a rule that ended on 15 July does not pay for July.
    expect(activeForPeriod('2026-01-01', '2026-07-15', p)).toBe(false)
  })

  it('pays for the period it ends exactly on', () => {
    expect(activeForPeriod('2026-01-01', '2026-07-31', p)).toBe(true)
  })
})
