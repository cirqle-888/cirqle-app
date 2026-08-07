import { describe, it, expect } from 'vitest'
import { duePeriods, nextDueDate, periodKey, type RecurringRule } from './recurring-schedule'

const rule = (over: Partial<RecurringRule> = {}): RecurringRule => ({
  id: 'r1',
  start_date: '2026-01-01',
  end_date: null,
  day_of_month: 1,
  frequency: 'monthly',
  ...over,
})

describe('periodKey', () => {
  it('is month-scoped for monthly and year-scoped for yearly', () => {
    expect(periodKey('monthly', 2026, 7)).toBe('2026-07')
    expect(periodKey('yearly', 2026, 7)).toBe('2026')
  })
})

describe('duePeriods', () => {
  it('returns one occurrence per month up to today, dated on its OWN due date', () => {
    expect(duePeriods(rule(), '2026-03-15')).toEqual([
      { period: '2026-01', postDate: '2026-01-01' },
      { period: '2026-02', postDate: '2026-02-01' },
      { period: '2026-03', postDate: '2026-03-01' },
    ])
  })

  it('never posts ahead of time — a due date later this month is not yet due', () => {
    expect(duePeriods(rule({ day_of_month: 20 }), '2026-01-15')).toEqual([])
  })

  it('skips periods already posted (idempotency across cron runs)', () => {
    expect(duePeriods(rule(), '2026-03-15', ['2026-01', '2026-02'])).toEqual([
      { period: '2026-03', postDate: '2026-03-01' },
    ])
  })

  it('is a no-op when everything is already posted', () => {
    expect(duePeriods(rule(), '2026-03-15', ['2026-01', '2026-02', '2026-03'])).toEqual([])
  })

  it('caps catch-up after a long outage', () => {
    const out = duePeriods(rule(), '2027-12-31', [], 12)
    expect(out).toHaveLength(12)
    expect(out[0].period).toBe('2026-01')
  })

  it('stops at end_date', () => {
    expect(duePeriods(rule({ end_date: '2026-02-28' }), '2026-06-01').map(o => o.period))
      .toEqual(['2026-01', '2026-02'])
  })

  it('does not back-date the first period when the rule starts mid-month', () => {
    // Rule starts 20 Jul but nominally posts on the 1st: July is skipped,
    // August is the first real occurrence.
    expect(duePeriods(rule({ start_date: '2026-07-20', day_of_month: 1 }), '2026-09-05'))
      .toEqual([
        { period: '2026-08', postDate: '2026-08-01' },
        { period: '2026-09', postDate: '2026-09-01' },
      ])
  })

  it('handles yearly cadence on the start month', () => {
    expect(duePeriods(rule({ frequency: 'yearly', start_date: '2024-04-10', day_of_month: 10 }), '2026-06-01'))
      .toEqual([
        { period: '2024', postDate: '2024-04-10' },
        { period: '2025', postDate: '2025-04-10' },
        { period: '2026', postDate: '2026-04-10' },
      ])
  })

  it('rolls the year over correctly', () => {
    expect(duePeriods(rule({ start_date: '2026-11-01' }), '2027-01-15').map(o => o.period))
      .toEqual(['2026-11', '2026-12', '2027-01'])
  })

  it('clamps an out-of-range day into the safe 1-28 window', () => {
    expect(duePeriods(rule({ day_of_month: 31 }), '2026-01-31')[0].postDate).toBe('2026-01-28')
  })
})

describe('nextDueDate', () => {
  it('reports the next posting date after today', () => {
    expect(nextDueDate(rule({ day_of_month: 5 }), '2026-03-10')).toBe('2026-04-05')
  })

  it('returns null once the rule has ended', () => {
    expect(nextDueDate(rule({ end_date: '2026-02-28' }), '2026-03-10')).toBeNull()
  })
})
