import { describe, it, expect } from 'vitest'
import {
  toISODate, todayISO, monthStartISO, monthEndISO, lastDayOfMonthISO, daysFromTodayISO,
  addDaysISO, formatISODateShort,
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

describe('addDaysISO', () => {
  it('counts terms from the date on the document', () => {
    // Net-30 off an issue date, which is the whole reason it takes a string:
    // a back-dated invoice must get a back-dated (already overdue) due date.
    expect(addDaysISO('2026-08-15', 30)).toBe('2026-09-14')
    expect(addDaysISO('2026-01-01', 14)).toBe('2026-01-15')
    expect(addDaysISO('2026-08-15', 0)).toBe('2026-08-15')
  })

  it('steps backwards for a negative delta', () => {
    expect(addDaysISO('2026-08-01', -1)).toBe('2026-07-31')
  })

  it('crosses month, year and leap-day boundaries', () => {
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysISO('2026-01-31', 1)).toBe('2026-02-01')
    // 2028 is a leap year — 28 Feb + 1 is the 29th, not 1 March.
    expect(addDaysISO('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDaysISO('2026-02-28', 1)).toBe('2026-03-01')
  })

  it('is independent of the host timezone', () => {
    // The input is already a calendar date, so no instant is involved and
    // there is nothing for a process timezone to shift. This is the property
    // the old `new Date(iso).toISOString()` round-trip did not have.
    expect(addDaysISO('2026-08-15', 30)).toBe('2026-09-14')
  })

  it('returns empty string for malformed input rather than a NaN date', () => {
    // These land straight in a date column: '' is rejected loudly, whereas
    // 'NaN-NaN-NaN' silently becomes NULL.
    for (const bad of ['', '  ', 'not-a-date', '2026-8-15', '15-08-2026', '2026-08-15T00:00:00Z']) {
      expect(addDaysISO(bad, 30)).toBe('')
    }
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

describe('formatISODateShort', () => {
  it('formats a plain ISO date without wrapping', () => {
    expect(formatISODateShort('2026-08-30')).toBe('30 Aug 26')
    expect(formatISODateShort('2026-01-01')).toBe('1 Jan 26')
    expect(formatISODateShort('2026-12-31')).toBe('31 Dec 26')
  })

  it('does not shift the day in a western timezone', () => {
    // The bug this avoids: new Date('2026-08-30') is UTC midnight, so
    // toLocaleDateString in, say, America/New_York renders the 29th. The
    // function never constructs a Date, so the calendar day is whatever the
    // string says, everywhere.
    const original = process.env.TZ
    try {
      process.env.TZ = 'America/Los_Angeles'
      expect(formatISODateShort('2026-08-30')).toBe('30 Aug 26')
      process.env.TZ = 'Pacific/Kiritimati'
      expect(formatISODateShort('2026-08-30')).toBe('30 Aug 26')
    } finally {
      process.env.TZ = original
    }
  })

  it('returns an empty string rather than NaN for bad input', () => {
    for (const bad of ['', null, undefined, 'not-a-date', '2026-8-3', '30-08-2026', '2026-13-01', '2026-00-10']) {
      expect(formatISODateShort(bad as string)).toBe('')
    }
  })
})
