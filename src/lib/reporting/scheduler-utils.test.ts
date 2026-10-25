import { describe, it, expect } from 'vitest'
import { computeNextRun, computeDateRange, isValidTimeZone } from './scheduler-utils'

const at = (iso: string) => new Date(iso)

describe('computeNextRun', () => {
  it('weekly on a Monday after the hour → next Monday (was: today, in the past)', () => {
    // 2026-10-19 is a Monday
    expect(computeNextRun('weekly', 7, 'UTC', at('2026-10-19T08:00:00Z'))).toBe('2026-10-26T07:00:00.000Z')
  })

  it('weekly on a Monday before the hour → today', () => {
    expect(computeNextRun('weekly', 7, 'UTC', at('2026-10-19T06:00:00Z'))).toBe('2026-10-19T07:00:00.000Z')
  })

  it('monthly mid-month before the hour → 1st of next month (was: today)', () => {
    expect(computeNextRun('monthly', 7, 'UTC', at('2026-10-24T06:00:00Z'))).toBe('2026-11-01T07:00:00.000Z')
  })

  it('monthly on the 1st before the hour → today', () => {
    expect(computeNextRun('monthly', 7, 'UTC', at('2026-11-01T03:00:00Z'))).toBe('2026-11-01T07:00:00.000Z')
  })

  it('quarterly → next quarter start', () => {
    expect(computeNextRun('quarterly', 7, 'UTC', at('2026-10-24T06:00:00Z'))).toBe('2027-01-01T07:00:00.000Z')
    expect(computeNextRun('quarterly', 7, 'UTC', at('2026-02-10T06:00:00Z'))).toBe('2026-04-01T07:00:00.000Z')
  })

  it('yearly → 1 January', () => {
    expect(computeNextRun('yearly', 7, 'UTC', at('2026-10-24T06:00:00Z'))).toBe('2027-01-01T07:00:00.000Z')
  })

  it('daily before/after the hour', () => {
    expect(computeNextRun('daily', 7, 'UTC', at('2026-10-24T06:00:00Z'))).toBe('2026-10-24T07:00:00.000Z')
    expect(computeNextRun('daily', 7, 'UTC', at('2026-10-24T07:00:00Z'))).toBe('2026-10-25T07:00:00.000Z')
  })

  it('handles the India half-hour offset', () => {
    // 07:00 IST = 01:30 UTC. At 02:00 UTC on 24 Oct it is 07:30 IST → tomorrow.
    expect(computeNextRun('daily', 7, 'Asia/Kolkata', at('2026-10-24T02:00:00Z'))).toBe('2026-10-25T01:30:00.000Z')
    // Monthly in IST: 1 Nov 07:00 IST
    expect(computeNextRun('monthly', 7, 'Asia/Kolkata', at('2026-10-24T02:00:00Z'))).toBe('2026-11-01T01:30:00.000Z')
  })

  it('is DST-correct (New York, spring 2027)', () => {
    // 14 Mar 2027 US DST starts; 07:00 EDT = 11:00 UTC; the day before 07:00 EST = 12:00 UTC.
    expect(computeNextRun('daily', 7, 'America/New_York', at('2027-03-13T13:00:00Z'))).toBe('2027-03-14T11:00:00.000Z')
    expect(computeNextRun('daily', 7, 'America/New_York', at('2027-03-13T10:00:00Z'))).toBe('2027-03-13T12:00:00.000Z')
  })

  it('crosses a year and a leap day', () => {
    expect(computeNextRun('monthly', 7, 'UTC', at('2027-12-15T00:00:00Z'))).toBe('2028-01-01T07:00:00.000Z')
    expect(computeNextRun('daily', 7, 'UTC', at('2028-02-28T08:00:00Z'))).toBe('2028-02-29T07:00:00.000Z')
  })

  it('always returns a future instant', () => {
    const now = at('2026-10-19T07:00:00Z')
    for (const f of ['daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'custom'] as const) {
      expect(new Date(computeNextRun(f, 7, 'UTC', now)).getTime()).toBeGreaterThan(now.getTime())
    }
  })

  it('rejects an invalid hour or zone', () => {
    expect(() => computeNextRun('daily', 24)).toThrow()
    expect(() => computeNextRun('daily', 7, 'Mars/Olympus')).toThrow()
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true)
    expect(isValidTimeZone('nope')).toBe(false)
  })
})

describe('computeDateRange', () => {
  it('uses the schedule zone for "today"', () => {
    // 20:00 UTC on 31 Oct is already 1 Nov in India → monthly = October.
    expect(computeDateRange('monthly', at('2026-10-31T20:00:00Z'), 'Asia/Kolkata'))
      .toEqual({ dateFrom: '2026-10-01', dateTo: '2026-10-31' })
    // In UTC it is still 31 Oct → September.
    expect(computeDateRange('monthly', at('2026-10-31T20:00:00Z'), 'UTC'))
      .toEqual({ dateFrom: '2026-09-01', dateTo: '2026-09-30' })
  })

  it('weekly = previous Mon–Sun, daily = yesterday', () => {
    expect(computeDateRange('weekly', at('2026-10-26T07:00:00Z'))).toEqual({ dateFrom: '2026-10-19', dateTo: '2026-10-25' })
    expect(computeDateRange('daily', at('2026-03-01T07:00:00Z'))).toEqual({ dateFrom: '2026-02-28', dateTo: '2026-02-28' })
  })
})
