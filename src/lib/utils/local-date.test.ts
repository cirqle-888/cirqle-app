import { describe, it, expect } from 'vitest'
import {
  toISODate, todayISO, monthStartISO, monthEndISO, lastDayOfMonthISO, daysFromTodayISO,
} from './local-date'

/**
 * Unit coverage for the calendar-date helpers.
 *
 * Every input is an ABSOLUTE instant (explicit UTC or +05:30 offset) rather
 * than `new Date(y, m, d)`, which would mean a different moment on every
 * machine. These helpers answer "which day is this instant, on the India
 * business calendar", so the input has to be an instant for the question to
 * have one answer — and that is what makes this file pass identically under
 * UTC, Asia/Kolkata, America/New_York and Pacific/Auckland.
 *
 * Business-rule coverage (invoices, payroll, recurrence, report windows) lives
 * in ist-business-dates.test.ts.
 */

const at = (iso: string) => new Date(iso)

describe('toISODate', () => {
  it('names the India calendar day for an instant', () => {
    expect(toISODate(at('2026-08-01T00:00:00+05:30'))).toBe('2026-08-01')
    expect(toISODate(at('2026-01-01T00:00:00+05:30'))).toBe('2026-01-01')
    expect(toISODate(at('2026-12-31T23:59:59+05:30'))).toBe('2026-12-31')
  })

  it('resolves a UTC instant onto the IST day it actually falls on', () => {
    // 19:30 UTC is already 01:00 the NEXT day in IST — the +5:30 boundary.
    expect(toISODate(at('2026-08-14T19:30:00Z'))).toBe('2026-08-15')
    expect(toISODate(at('2026-08-14T18:29:00Z'))).toBe('2026-08-14')
  })

  it('pads single-digit months and days', () => {
    expect(toISODate(at('2026-03-05T12:00:00+05:30'))).toBe('2026-03-05')
  })
})

describe('todayISO', () => {
  it('holds the day from IST midnight through to 23:59', () => {
    expect(todayISO(at('2026-08-15T00:00:00+05:30'))).toBe('2026-08-15')
    expect(todayISO(at('2026-08-15T00:30:00+05:30'))).toBe('2026-08-15')
    expect(todayISO(at('2026-08-15T23:45:00+05:30'))).toBe('2026-08-15')
  })

  it('turns over at IST midnight', () => {
    expect(todayISO(at('2026-08-14T23:59:59+05:30'))).toBe('2026-08-14')
    expect(todayISO(at('2026-08-15T00:00:00+05:30'))).toBe('2026-08-15')
  })
})

describe('month bounds', () => {
  it('bounds the current month', () => {
    const now = at('2026-08-14T02:00:00+05:30')
    expect(monthStartISO(0, now)).toBe('2026-08-01')
    expect(monthEndISO(0, now)).toBe('2026-08-31')
  })

  it('walks months across a year boundary', () => {
    expect(monthStartISO(-1, at('2026-01-15T12:00:00+05:30'))).toBe('2025-12-01')
    expect(monthEndISO(-1, at('2026-01-15T12:00:00+05:30'))).toBe('2025-12-31')
    expect(monthStartISO(1, at('2026-12-15T12:00:00+05:30'))).toBe('2027-01-01')
  })

  it('knows month lengths, including leap February', () => {
    expect(lastDayOfMonthISO(2026, 2)).toBe('2026-02-28')
    expect(lastDayOfMonthISO(2028, 2)).toBe('2028-02-29') // leap year
    expect(lastDayOfMonthISO(2026, 4)).toBe('2026-04-30')
    expect(lastDayOfMonthISO(2026, 12)).toBe('2026-12-31')
  })
})

describe('daysFromTodayISO', () => {
  it('steps whole days in both directions', () => {
    const now = at('2026-08-15T01:00:00+05:30')
    expect(daysFromTodayISO(0, now)).toBe('2026-08-15')
    expect(daysFromTodayISO(-1, now)).toBe('2026-08-14')
    expect(daysFromTodayISO(1, now)).toBe('2026-08-16')
    expect(daysFromTodayISO(-6, now)).toBe('2026-08-09')
  })

  it('crosses month and year boundaries', () => {
    expect(daysFromTodayISO(-1, at('2026-08-01T01:00:00+05:30'))).toBe('2026-07-31')
    expect(daysFromTodayISO(1, at('2026-12-31T23:00:00+05:30'))).toBe('2027-01-01')
  })
})

describe('agreement with the real clock', () => {
  it('returns the current India calendar day', () => {
    const now = new Date()
    const expected = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now)
    expect(todayISO()).toBe(expected)
  })
})
