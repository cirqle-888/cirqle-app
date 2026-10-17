import { describe, it, expect } from 'vitest'
import { averageByWeekdayHour } from './online-followers'

/**
 * The Graph response shape is the part most likely to change under us, so the
 * shaping is tested against fixtures rather than a live account.
 */

// 2026-10-12 is a Monday, 2026-10-13 a Tuesday (both UTC).
const day = (endTime: string, byHour: Record<string, number>) => ({ end_time: endTime, value: byHour })

describe('averageByWeekdayHour', () => {
  it('averages the same weekday across several weeks', () => {
    const res = averageByWeekdayHour([
      day('2026-10-12T07:00:00+0000', { '19': 100 }),
      day('2026-10-19T07:00:00+0000', { '19': 200 }),
      day('2026-10-26T07:00:00+0000', { '19': 300 }),
    ])
    const mon19 = res.rows.find(r => r.weekday === 1 && r.hour === 19)
    expect(mon19).toMatchObject({ score: 200, samples: 3 })
    expect(res.days).toBe(3)
  })

  it('keeps weekdays apart rather than averaging the whole window', () => {
    const res = averageByWeekdayHour([
      day('2026-10-12T07:00:00+0000', { '19': 1000 }), // Monday
      day('2026-10-13T07:00:00+0000', { '19': 10 }),   // Tuesday
    ])
    expect(res.rows.find(r => r.weekday === 1 && r.hour === 19)?.score).toBe(1000)
    expect(res.rows.find(r => r.weekday === 2 && r.hour === 19)?.score).toBe(10)
  })

  it('returns the strongest hour first, which is what the planner reads', () => {
    const res = averageByWeekdayHour([
      day('2026-10-12T07:00:00+0000', { '9': 50, '19': 400, '23': 120 }),
    ])
    expect(res.rows.map(r => r.hour)).toEqual([19, 23, 9])
  })

  it('rounds away false precision but keeps the ordering', () => {
    const res = averageByWeekdayHour([
      day('2026-10-12T07:00:00+0000', { '19': 10 }),
      day('2026-10-19T07:00:00+0000', { '19': 11 }),
      day('2026-10-26T07:00:00+0000', { '19': 11 }),
    ])
    expect(res.rows[0].score).toBe(10.7)
  })

  it('drops a day with no end_time rather than guessing its weekday', () => {
    const res = averageByWeekdayHour([
      { value: { '19': 999 } },
      day('2026-10-12T07:00:00+0000', { '19': 100 }),
    ])
    expect(res.days).toBe(1)
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0].score).toBe(100)
  })

  it('survives the shapes Meta actually breaks in', () => {
    const res = averageByWeekdayHour([
      day('2026-10-12T07:00:00+0000', { '19': 100 }),
      { end_time: '2026-10-13T07:00:00+0000', value: null as unknown as Record<string, number> },
      { end_time: 'not-a-date', value: { '19': 5 } },
      // An array where an object was promised.
      { end_time: '2026-10-14T07:00:00+0000', value: [1, 2, 3] as unknown as Record<string, number> },
      // Hours outside the clock, and a non-numeric count.
      day('2026-10-15T07:00:00+0000', { '24': 7, '-1': 7, '12': Number.NaN as unknown as number }),
    ])
    expect(res.days).toBe(1)
    expect(res.rows).toEqual([{ weekday: 1, hour: 19, score: 100, samples: 1 }])
  })

  it('is empty-safe', () => {
    expect(averageByWeekdayHour([])).toEqual({ rows: [], days: 0 })
  })

  it('never reports an hour outside 0–23', () => {
    const res = averageByWeekdayHour([
      day('2026-10-12T07:00:00+0000', Object.fromEntries(
        Array.from({ length: 24 }, (_, h) => [String(h), h * 10]),
      )),
    ])
    expect(res.rows).toHaveLength(24)
    for (const r of res.rows) {
      expect(r.hour).toBeGreaterThanOrEqual(0)
      expect(r.hour).toBeLessThanOrEqual(23)
      expect(r.weekday).toBeGreaterThanOrEqual(0)
      expect(r.weekday).toBeLessThanOrEqual(6)
    }
  })
})
