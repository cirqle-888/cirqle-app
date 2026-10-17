import { describe, it, expect } from 'vitest'
import { parseBestTimes, parseCount, parseHour, spreadAcrossWeek } from './best-times-import'

describe('parseCount', () => {
  it('reads the shapes dashboards print', () => {
    expect(parseCount('1240')).toBe(1240)
    expect(parseCount('1,240')).toBe(1240)
    expect(parseCount('1.2K')).toBe(1200)
    expect(parseCount('3.4k')).toBe(3400)
    expect(parseCount('2M')).toBe(2_000_000)
    expect(parseCount('12%')).toBe(12)
    expect(parseCount(' 88 ')).toBe(88)
  })

  it('refuses what it would have to guess at', () => {
    for (const bad of ['', 'abc', '1.2.3', '-5', '12:30', 'K']) {
      expect(parseCount(bad)).toBeNull()
    }
  })
})

describe('parseHour', () => {
  it('reads 24-hour and 12-hour clocks', () => {
    expect(parseHour('19:00')).toBe(19)
    expect(parseHour('19')).toBe(19)
    expect(parseHour('7pm')).toBe(19)
    expect(parseHour('7 PM')).toBe(19)
    expect(parseHour('12am')).toBe(0)
    expect(parseHour('12pm')).toBe(12)
    expect(parseHour('00:00')).toBe(0)
  })

  it('rejects hours that are not on a clock', () => {
    for (const bad of ['24', '25', '13pm', '0pm', 'noon', '']) {
      expect(parseHour(bad)).toBeNull()
    }
  })
})

describe('parseBestTimes', () => {
  it('reads a plain two-column paste', () => {
    const r = parseBestTimes(`
      09:00  120
      12:00  340
      19:00  1,240
      23:00  400
    `)
    expect(r.rows).toEqual([
      { weekday: null, hour: 9, score: 120 },
      { weekday: null, hour: 12, score: 340 },
      { weekday: null, hour: 19, score: 1240 },
      { weekday: null, hour: 23, score: 400 },
    ])
    expect(r.hasWeekdays).toBe(false)
    expect(r.ignored).toEqual([])
  })

  it('reads a 12-hour clock with K suffixes', () => {
    const r = parseBestTimes('7 PM   1.2K\n9 AM   340')
    expect(r.rows).toEqual([
      { weekday: null, hour: 19, score: 1200 },
      { weekday: null, hour: 9, score: 340 },
    ])
  })

  it('picks up a weekday named on the same line', () => {
    const r = parseBestTimes('Mon 7pm 1240\nTuesday, 19:00, 980')
    expect(r.rows).toEqual([
      { weekday: 1, hour: 19, score: 1240 },
      { weekday: 2, hour: 19, score: 980 },
    ])
    expect(r.hasWeekdays).toBe(true)
  })

  it('carries a day heading down to the rows beneath it', () => {
    const r = parseBestTimes(`
      Monday
      09:00 100
      19:00 900
      Tuesday
      19:00 500
    `)
    expect(r.rows).toEqual([
      { weekday: 1, hour: 9, score: 100 },
      { weekday: 1, hour: 19, score: 900 },
      { weekday: 2, hour: 19, score: 500 },
    ])
    expect(r.hasWeekdays).toBe(true)
  })

  it('handles arrows, pipes and trailing words', () => {
    const r = parseBestTimes('19:00 → 1,240 followers online\n20:00 | 900 people')
    expect(r.rows).toEqual([
      { weekday: null, hour: 19, score: 1240 },
      { weekday: null, hour: 20, score: 900 },
    ])
  })

  it('hands back every line it could not read, rather than dropping them', () => {
    const r = parseBestTimes(`
      Most active times
      19:00 1240
      total engagement up
      lorem ipsum
    `)
    expect(r.rows).toHaveLength(1)
    expect(r.ignored).toEqual(['Most active times', 'total engagement up', 'lorem ipsum'])
  })

  it('does not invent a row from an hour with no number', () => {
    const r = parseBestTimes('19:00\n20:00 500')
    expect(r.rows).toEqual([{ weekday: null, hour: 20, score: 500 }])
    expect(r.ignored).toEqual(['19:00'])
  })

  it('is empty-safe', () => {
    expect(parseBestTimes('')).toEqual({ rows: [], hasWeekdays: false, ignored: [] })
    expect(parseBestTimes('   \n\n  ')).toEqual({ rows: [], hasWeekdays: false, ignored: [] })
  })

  it('never produces an hour off the clock, whatever it is fed', () => {
    const r = parseBestTimes('25:00 500\n99 300\n-1 100\n19:00 7')
    for (const row of r.rows) {
      expect(row.hour).toBeGreaterThanOrEqual(0)
      expect(row.hour).toBeLessThanOrEqual(23)
    }
  })
})

describe('spreadAcrossWeek', () => {
  it('copies a single day’s curve across every weekday', () => {
    const out = spreadAcrossWeek([{ weekday: null, hour: 19, score: 1000 }])
    expect(out).toHaveLength(7)
    expect(new Set(out.map(r => r.weekday))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]))
    expect(out.every(r => r.hour === 19 && r.score === 1000)).toBe(true)
  })

  it('lets an explicitly named day beat the spread one', () => {
    const out = spreadAcrossWeek([
      { weekday: null, hour: 19, score: 100 },
      { weekday: 1, hour: 19, score: 999 },
    ])
    expect(out.find(r => r.weekday === 1 && r.hour === 19)?.score).toBe(999)
    expect(out.find(r => r.weekday === 2 && r.hour === 19)?.score).toBe(100)
  })

  it('never emits the same weekday/hour cell twice', () => {
    const out = spreadAcrossWeek([
      { weekday: null, hour: 19, score: 100 },
      { weekday: null, hour: 19, score: 200 },
    ])
    expect(out).toHaveLength(7)
  })

  it('passes fully-specified rows through untouched', () => {
    const rows = [{ weekday: 3 as const, hour: 8, score: 42 }]
    expect(spreadAcrossWeek(rows)).toEqual([{ weekday: 3, hour: 8, score: 42 }])
  })
})
