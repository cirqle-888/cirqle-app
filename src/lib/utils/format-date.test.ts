import { describe, it, expect } from 'vitest'
import { formatDate, formatDateTime, formatTaskDate, fullTaskDate } from './format-date'

describe('formatDate', () => {
  it('renders an ISO date as day, short month, full year', () => {
    expect(formatDate('2026-08-12')).toBe('12 Aug 2026')
    expect(formatDate('2026-01-01')).toBe('1 Jan 2026')
  })

  it('reads a full timestamp too', () => {
    expect(formatDate('2026-08-12T14:05:00')).toBe('12 Aug 2026')
  })

  it('accepts a Date object', () => {
    expect(formatDate(new Date(2026, 7, 12))).toBe('12 Aug 2026')
  })

  it('keeps the day put — a bare ISO date never slips to the day before', () => {
    expect(formatDate('2026-03-01')).toBe('1 Mar 2026')
  })

  it('falls back to an em-dash when there is nothing to show', () => {
    expect(formatDate(null)).toBe('—')
    expect(formatDate(undefined)).toBe('—')
    expect(formatDate('')).toBe('—')
    expect(formatDate('   ')).toBe('—')
  })

  it('falls back to an em-dash rather than printing "Invalid Date"', () => {
    expect(formatDate('not a date')).toBe('—')
    expect(formatDate('2026-13-45')).toBe('—')
    expect(formatDate(new Date('nope'))).toBe('—')
  })
})

describe('formatDateTime', () => {
  it('adds the time to the date', () => {
    const out = formatDateTime('2026-08-12T14:05:00')
    expect(out).toContain('12 Aug 2026')
    expect(out).toMatch(/05/)
  })

  it('uses the same em-dash fallback as formatDate', () => {
    expect(formatDateTime(null)).toBe('—')
    expect(formatDateTime(undefined)).toBe('—')
    expect(formatDateTime('')).toBe('—')
    expect(formatDateTime('not a date')).toBe('—')
  })
})

describe('formatTaskDate (unchanged behaviour)', () => {
  it('still returns strict DD-MM-YYYY', () => {
    expect(formatTaskDate('2026-08-12')).toBe('12-08-2026')
  })

  it('still returns an empty string for nothing', () => {
    expect(formatTaskDate(null)).toBe('')
    expect(formatTaskDate(undefined)).toBe('')
    expect(formatTaskDate('')).toBe('')
  })

  it('still echoes back input it cannot parse', () => {
    expect(formatTaskDate('not a date')).toBe('not a date')
  })
})

describe('fullTaskDate (unchanged behaviour)', () => {
  it('still spells out the weekday and month', () => {
    expect(fullTaskDate('2026-08-12')).toBe('Wednesday, 12 August 2026')
  })

  it('still returns an empty string for nothing', () => {
    expect(fullTaskDate(null)).toBe('')
    expect(fullTaskDate('')).toBe('')
  })
})
