import { describe, it, expect } from 'vitest'
import {
  toISODate, todayISO, monthStartISO, monthEndISO, lastDayOfMonthISO, daysFromTodayISO,
} from './local-date'

/**
 * These pin the exact failures that motivated the helper. The suite runs with
 * TZ unset, so the assertions are written to hold in ANY zone — each one
 * compares against the local calendar fields rather than a hardcoded string,
 * except where the input already names a local date unambiguously.
 */
describe('local-date', () => {
  it('reads the local calendar day, not the UTC one', () => {
    // 1 Aug local midnight. toISOString() would say 31 Jul anywhere east of UTC.
    expect(toISODate(new Date(2026, 7, 1))).toBe('2026-08-01')
    expect(toISODate(new Date(2026, 0, 1))).toBe('2026-01-01')
    expect(toISODate(new Date(2026, 11, 31))).toBe('2026-12-31')
  })

  it('pads single-digit months and days', () => {
    expect(toISODate(new Date(2026, 2, 5))).toBe('2026-03-05')
  })

  it('keeps a late-night "today" on the correct day', () => {
    // 00:30 local on 15 Aug — the window where the UTC conversion says 14 Aug
    // for every zone from UTC+1 eastward.
    expect(todayISO(new Date(2026, 7, 15, 0, 30))).toBe('2026-08-15')
    expect(todayISO(new Date(2026, 7, 15, 23, 45))).toBe('2026-08-15')
  })

  it('bounds the current month without slipping into the previous one', () => {
    const now = new Date(2026, 7, 14, 2, 0) // 14 Aug, 02:00 local
    expect(monthStartISO(0, now)).toBe('2026-08-01')
    expect(monthEndISO(0, now)).toBe('2026-08-31')
  })

  it('walks months across a year boundary', () => {
    const jan = new Date(2026, 0, 15)
    expect(monthStartISO(-1, jan)).toBe('2025-12-01')
    expect(monthEndISO(-1, jan)).toBe('2025-12-31')
    const dec = new Date(2026, 11, 15)
    expect(monthStartISO(1, dec)).toBe('2027-01-01')
  })

  it('knows month lengths, including leap February', () => {
    expect(lastDayOfMonthISO(2026, 2)).toBe('2026-02-28')
    expect(lastDayOfMonthISO(2028, 2)).toBe('2028-02-29') // leap year
    expect(lastDayOfMonthISO(2026, 4)).toBe('2026-04-30')
    expect(lastDayOfMonthISO(2026, 12)).toBe('2026-12-31')
  })

  it('steps whole days in both directions', () => {
    const now = new Date(2026, 7, 15, 1, 0)
    expect(daysFromTodayISO(0, now)).toBe('2026-08-15')
    expect(daysFromTodayISO(-1, now)).toBe('2026-08-14')
    expect(daysFromTodayISO(1, now)).toBe('2026-08-16')
    expect(daysFromTodayISO(-6, now)).toBe('2026-08-09')
  })

  it('crosses month and year boundaries when stepping days', () => {
    expect(daysFromTodayISO(-1, new Date(2026, 7, 1, 1, 0))).toBe('2026-07-31')
    expect(daysFromTodayISO(1, new Date(2026, 11, 31, 23, 0))).toBe('2027-01-01')
  })

  it('agrees with the local calendar for the real current date', () => {
    const now = new Date()
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    expect(todayISO()).toBe(expected)
  })
})
