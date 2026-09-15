import { describe, it, expect } from 'vitest'
import {
  closedCyclesBetween, cycleFor, cycleLabel, daysInMonth, inCycle,
  previousCycle, statementDateIn,
} from './cycle'

/**
 * Cycles are where a reconciliation quietly goes wrong.
 *
 * Two cycles that overlap put one charge on two statements, and both appear to
 * balance. Two that leave a gap drop a charge off every statement and nobody
 * notices until the card balance drifts. The month-end group below is the one
 * that matters: a statement day of 31 has no February to land on.
 */

describe('a cycle that ends mid-month', () => {
  it('runs from the day after last month\'s statement day', () => {
    expect(cycleFor('2026-09-01', 16)).toEqual({ start: '2026-08-17', end: '2026-09-16' })
  })

  it('puts a charge ON the statement day in THAT cycle, not the next', () => {
    // A charge made on the 16th with a statement day of 16 appears on that
    // statement. This is the issuer's convention and what a person expects.
    expect(cycleFor('2026-09-16', 16)?.end).toBe('2026-09-16')
  })

  it('puts the day after into the next cycle', () => {
    expect(cycleFor('2026-09-17', 16)).toEqual({ start: '2026-09-17', end: '2026-10-16' })
  })

  it('crosses a year boundary in both directions', () => {
    expect(cycleFor('2026-01-05', 16)).toEqual({ start: '2025-12-17', end: '2026-01-16' })
    expect(cycleFor('2025-12-20', 16)).toEqual({ start: '2025-12-17', end: '2026-01-16' })
  })
})

describe('month-end statement days', () => {
  it('clamps to the last day of a short month rather than rolling forward', () => {
    // Rolling a 31st into 1 March would make February's cycle overlap March's.
    expect(statementDateIn(2026, 2, 31)).toBe('2026-02-28')
    expect(statementDateIn(2024, 2, 31)).toBe('2024-02-29')   // leap year
    expect(statementDateIn(2026, 4, 31)).toBe('2026-04-30')
    expect(statementDateIn(2026, 1, 31)).toBe('2026-01-31')
  })

  it('produces a February cycle that touches January and March exactly', () => {
    const feb = cycleFor('2026-02-10', 31)
    expect(feb).toEqual({ start: '2026-02-01', end: '2026-02-28' })
    const mar = cycleFor('2026-03-10', 31)
    expect(mar).toEqual({ start: '2026-03-01', end: '2026-03-31' })
    // No gap and no overlap between them.
    expect(mar!.start > feb!.end).toBe(true)
  })

  it('handles a 30th in February too', () => {
    // January HAS a 30th, so that cycle starts on the 31st and ends on the
    // 28th — the clamp applies only to the month that is too short, which is
    // what keeps the cycle before it from being shortened as well.
    expect(cycleFor('2026-02-15', 30)).toEqual({ start: '2026-01-31', end: '2026-02-28' })
  })

  it('treats day 1 as a whole calendar month', () => {
    expect(cycleFor('2026-05-20', 1)).toEqual({ start: '2026-05-02', end: '2026-06-01' })
  })
})

describe('consecutive cycles never overlap and never leave a gap', () => {
  it.each([1, 5, 15, 16, 28, 29, 30, 31])('holds for statement day %i', day => {
    // Walk two years of cycles and check each starts the day after the last
    // one ended. A single off-by-one here loses or duplicates a charge.
    let cycle = cycleFor('2024-06-15', day)!
    for (let i = 0; i < 24; i++) {
      const next = cycleFor(cycle.end + '', day)!
      const after = cycleFor(nextDayOf(cycle.end), day)!
      expect(next.end, `cycle containing its own end, day ${day}`).toBe(cycle.end)
      expect(after.start, `gap or overlap after ${cycle.end}, day ${day}`).toBe(nextDayOf(cycle.end))
      cycle = after
    }
  })

  it('previousCycle is the exact inverse of stepping forward', () => {
    const sept = cycleFor('2026-09-01', 16)!
    const aug = previousCycle(sept, 16)!
    expect(aug.end).toBe('2026-08-16')
    expect(nextDayOf(aug.end)).toBe(sept.start)
  })
})

/** The day after an ISO date, computed independently of the module under test. */
function nextDayOf(date: string): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

describe('which cycles can be imported', () => {
  it('EXCLUDES the cycle today falls in — it has not closed', () => {
    // There is no statement for a cycle still running; importing one would be
    // importing a guess.
    const cycles = closedCyclesBetween('2026-01-01', '2026-09-15', 16)
    expect(cycles.every(c => c.end < '2026-09-16')).toBe(true)
    expect(cycles[0].end).toBe('2026-08-16')
  })

  it('stops at the card\'s clean start', () => {
    const cycles = closedCyclesBetween('2026-06-01', '2026-09-15', 16)
    expect(cycles.map(c => c.end)).toEqual(['2026-08-16', '2026-07-16', '2026-06-16'])
  })

  it('is newest first, because that is the one being reconciled', () => {
    const cycles = closedCyclesBetween('2026-01-01', '2026-09-15', 16)
    expect(cycles[0].end > cycles[1].end).toBe(true)
  })

  it('is empty when the clean start is in the future', () => {
    expect(closedCyclesBetween('2027-01-01', '2026-09-15', 16)).toEqual([])
  })

  it('is bounded, so a far-past start cannot spin', () => {
    expect(closedCyclesBetween('1990-01-01', '2026-09-15', 16).length).toBeLessThanOrEqual(24)
  })
})

describe('the odds and ends', () => {
  it('knows how long a month is, leap years included', () => {
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2026, 12)).toBe(31)
  })

  it('answers membership on both inclusive ends', () => {
    const c = { start: '2026-08-17', end: '2026-09-16' }
    expect(inCycle('2026-08-17', c)).toBe(true)
    expect(inCycle('2026-09-16', c)).toBe(true)
    expect(inCycle('2026-08-16', c)).toBe(false)
    expect(inCycle('2026-09-17', c)).toBe(false)
  })

  it('labels a cycle the way a heading should read', () => {
    expect(cycleLabel({ start: '2026-08-17', end: '2026-09-16' })).toBe('17 Aug – 16 Sep 2026')
    expect(cycleLabel({ start: '2025-12-17', end: '2026-01-16' })).toBe('17 Dec 2025 – 16 Jan 2026')
  })

  it('refuses a malformed date instead of inventing a cycle', () => {
    expect(cycleFor('not-a-date', 16)).toBeNull()
    expect(cycleFor('2026-13-01', 16)).toBeNull()
  })
})
