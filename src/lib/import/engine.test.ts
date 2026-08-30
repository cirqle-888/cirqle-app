import { describe, it, expect } from 'vitest'
import { normalizeDate } from './engine'

/**
 * Regression coverage for import date parsing.
 *
 * This function decides what calendar date a historical spreadsheet row lands
 * on, so a wrong answer here is silently wrong DATA — a task filed to the wrong
 * month, an invoice issued in the wrong period, a payroll boundary missed. It
 * had no tests at all before this audit.
 *
 * Two behaviours are pinned deliberately:
 *   * an unparseable value comes back UNCHANGED, so the schema validators
 *     (/^\d{4}-\d{2}-\d{2}$/) reject the row instead of writing NULL;
 *   * an ambiguous numeric date is DAY-first, matching what every schema in
 *     ./schemas documents and the India business calendar.
 */

describe('normalizeDate — formats that must parse', () => {
  it('accepts ISO unchanged', () => {
    expect(normalizeDate('2024-07-06')).toBe('2024-07-06')
    expect(normalizeDate('2024-7-6')).toBe('2024-07-06')
  })

  it('accepts the DD-MMM-YYYY the job template asks for', () => {
    expect(normalizeDate('04-Dec-2023')).toBe('2023-12-04')
    expect(normalizeDate('06-July-2024')).toBe('2024-07-06')
  })

  it('accepts long human forms', () => {
    expect(normalizeDate('6 July 2024')).toBe('2024-07-06')
    expect(normalizeDate('July 6, 2024')).toBe('2024-07-06')
  })

  it('accepts the weekday-suffixed form the historical sheet used', () => {
    // The exact shape that made a bulk import fail: a trailing day name.
    expect(normalizeDate('06-July-2024, Saturday')).toBe('2024-07-06')
    expect(normalizeDate('06-Jul-2024, Sat')).toBe('2024-07-06')
    expect(normalizeDate('4 December 2023, Monday')).toBe('2023-12-04')
  })

  it('accepts 2-digit years as 2000+', () => {
    expect(normalizeDate('06-07-24')).toBe('2024-07-06')
  })
})

describe('normalizeDate — ambiguous dates are day-first', () => {
  it('reads DD/MM/YYYY, not MM/DD/YYYY, when both parts are <= 12', () => {
    // THE BUG: the separator used to decide this, so '06/07/2024' became
    // 7 June with a slash and 6 July with a dash — same date, two answers,
    // no error. Every schema documents DD-MM-YYYY, so day-first is correct.
    expect(normalizeDate('06/07/2024')).toBe('2024-07-06')
    expect(normalizeDate('06-07-2024')).toBe('2024-07-06')
    expect(normalizeDate('06.07.2024')).toBe('2024-07-06')
  })

  it('separator no longer changes the answer', () => {
    expect(normalizeDate('06/07/2024')).toBe(normalizeDate('06-07-2024'))
    expect(normalizeDate('01/02/2026')).toBe(normalizeDate('01-02-2026'))
  })

  it('still reads an unambiguous US date correctly', () => {
    // day > 12 in the second position can only be month-first.
    expect(normalizeDate('12/25/2023')).toBe('2023-12-25')
  })

  it('reads an unambiguous day-first date correctly', () => {
    expect(normalizeDate('25/12/2023')).toBe('2023-12-25')
    expect(normalizeDate('31-01-2026')).toBe('2026-01-31')
  })
})

describe('normalizeDate — impossible dates are rejected, not emitted', () => {
  it('rejects a day that does not exist in that month', () => {
    // Previously returned '2026-02-30', which looks like valid ISO, passed the
    // schema validator, and then threw at the Postgres insert — failing the
    // whole batch rather than naming the offending row.
    expect(normalizeDate('2026-02-30')).toBe('2026-02-30')
    expect(normalizeDate('31-04-2026')).toBe('31-04-2026')
  })

  it('rejects zero month and zero day', () => {
    // Previously became '2000-00-00'.
    expect(normalizeDate('00-00-0000')).toBe('00-00-0000')
  })

  it('rejects an out-of-range month', () => {
    expect(normalizeDate('13/13/2024')).toBe('13/13/2024')
  })

  it('accepts a real leap day and rejects a fake one', () => {
    expect(normalizeDate('29-02-2028')).toBe('2028-02-29')
    expect(normalizeDate('29-02-2026')).toBe('29-02-2026')
  })
})

describe('normalizeDate — unparseable input passes through untouched', () => {
  it('returns the original so the schema validator can reject the row', () => {
    // The contract that keeps bad data OUT of the database: this function
    // never invents a date, and never returns something NULL-shaped.
    for (const bad of ['not a date', 'TBD', '??', 'Jan']) {
      expect(normalizeDate(bad)).toBe(bad)
    }
  })

  it('treats empty as empty', () => {
    expect(normalizeDate('')).toBe('')
  })
})

describe('normalizeDate — independent of the host timezone', () => {
  it('never shifts the calendar day', () => {
    // Parsed via Date.UTC, so a machine in Auckland or New York agrees with
    // one in Kolkata. This suite runs under whatever TZ the machine has.
    expect(normalizeDate('01-01-2026')).toBe('2026-01-01')
    expect(normalizeDate('31-12-2026')).toBe('2026-12-31')
    expect(normalizeDate('1 January 2026')).toBe('2026-01-01')
  })
})
