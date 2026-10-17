import { describe, it, expect } from 'vitest'
import {
  normalizeTime, timeToMinutes, formatTime12, weekdayOf, postInstant, remindAt,
  slotsOn, suggestTimes, defaultTimeFor, assignTimes, postTiming,
  DEFAULT_REMINDER_MINUTES,
  type PostingSlot, type BestTime, type PlannableItem,
} from './posting-time'

/**
 * These run under whatever TZ the machine or CI happens to be on. Every
 * assertion here is about the India business calendar, so any result that
 * changes with the process timezone is a bug in the module, not the test.
 */

const slot = (over: Partial<PostingSlot> & { id: string; weekday: PostingSlot['weekday']; time: string }): PostingSlot => ({
  platforms: [], label: null, priority: 0, active: true, ...over,
})

// 2026-10-19 is a Monday; 2026-10-20 a Tuesday; 2026-10-25 a Sunday.
const MON = '2026-10-19'
const TUE = '2026-10-20'
const SUN = '2026-10-25'

describe('normalizeTime', () => {
  it('accepts what Postgres and people actually produce', () => {
    expect(normalizeTime('19:30:00')).toBe('19:30')   // TIME column
    expect(normalizeTime('7:05')).toBe('07:05')       // typed by hand
    expect(normalizeTime('  09:15  ')).toBe('09:15')
    expect(normalizeTime('19:30:00.000')).toBe('19:30')
    expect(normalizeTime('00:00')).toBe('00:00')
    expect(normalizeTime('23:59')).toBe('23:59')
  })

  it('rejects anything that would silently never match a slot', () => {
    for (const bad of ['24:00', '19:60', '7', '7:5', 'evening', '', '-1:00', null, undefined, 1930]) {
      expect(normalizeTime(bad as unknown)).toBeNull()
    }
  })
})

describe('timeToMinutes', () => {
  it('orders times as numbers, with unreadable input sorting first', () => {
    expect(timeToMinutes('00:00')).toBe(0)
    expect(timeToMinutes('09:30')).toBe(570)
    expect(timeToMinutes('23:59')).toBe(1439)
    expect(timeToMinutes('nonsense')).toBe(-1)
    expect(timeToMinutes(null)).toBe(-1)
  })
})

describe('formatTime12', () => {
  it('reads the way the office says it', () => {
    expect(formatTime12('19:30')).toBe('7:30 pm')
    expect(formatTime12('00:15')).toBe('12:15 am')
    expect(formatTime12('12:00')).toBe('12:00 pm')
    expect(formatTime12('09:05')).toBe('9:05 am')
    expect(formatTime12('bad')).toBe('')
  })
})

describe('weekdayOf', () => {
  it('reads the weekday off the date itself, not off the machine clock', () => {
    expect(weekdayOf(MON)).toBe(1)
    expect(weekdayOf(TUE)).toBe(2)
    expect(weekdayOf(SUN)).toBe(0)
  })

  it('refuses a shape it cannot read rather than guessing', () => {
    expect(() => weekdayOf('19-10-2026')).toThrow()
  })
})

describe('postInstant', () => {
  it('resolves a wall-clock plan on the India calendar', () => {
    // 19:30 IST is 14:00 UTC the same day.
    expect(postInstant(MON, '19:30')!.toISOString()).toBe('2026-10-19T14:00:00.000Z')
  })

  it('handles a time that crosses back over midnight UTC', () => {
    // 02:00 IST is 20:30 UTC the PREVIOUS day — the case a naive
    // `new Date(iso + 'T' + time)` gets wrong by a whole day.
    expect(postInstant(MON, '02:00')!.toISOString()).toBe('2026-10-18T20:30:00.000Z')
  })

  it('is null for input it cannot trust', () => {
    expect(postInstant(MON, '25:00')).toBeNull()
    expect(postInstant('not-a-date', '19:30')).toBeNull()
  })
})

describe('remindAt', () => {
  it('defaults to a quarter hour before', () => {
    expect(DEFAULT_REMINDER_MINUTES).toBe(15)
    const at = postInstant(MON, '19:30')!
    expect(remindAt(at)!.toISOString()).toBe('2026-10-19T13:45:00.000Z')
  })

  it('takes a custom lead and never runs backwards', () => {
    const at = postInstant(MON, '19:30')!
    expect(remindAt(at, 60)!.toISOString()).toBe('2026-10-19T13:00:00.000Z')
    expect(remindAt(at, -5)!.getTime()).toBe(at.getTime())
    expect(remindAt(null)).toBeNull()
  })
})

describe('slotsOn', () => {
  const slots = [
    slot({ id: 'b', weekday: 1, time: '19:30', priority: 1 }),
    slot({ id: 'a', weekday: 1, time: '09:00', priority: 0 }),
    slot({ id: 'tue', weekday: 2, time: '18:00' }),
    slot({ id: 'off', weekday: 1, time: '21:00', active: false }),
  ]

  it('returns only that weekday, in the order a batch should fill them', () => {
    expect(slotsOn(slots, MON).map(s => s.id)).toEqual(['a', 'b'])
    expect(slotsOn(slots, TUE).map(s => s.id)).toEqual(['tue'])
  })

  it('leaves out inactive slots and days with none', () => {
    expect(slotsOn(slots, MON).some(s => s.id === 'off')).toBe(false)
    expect(slotsOn(slots, SUN)).toEqual([])
  })

  it('falls back to clock order when priorities tie', () => {
    const tied = [
      slot({ id: 'late', weekday: 1, time: '20:00', priority: 5 }),
      slot({ id: 'early', weekday: 1, time: '08:00', priority: 5 }),
    ]
    expect(slotsOn(tied, MON).map(s => s.id)).toEqual(['early', 'late'])
  })
})

describe('suggestTimes', () => {
  const slots = [slot({ id: 's1', weekday: 1, time: '19:30', label: 'Prime evening' })]
  const best: BestTime[] = [
    { weekday: 1, hour: 21, score: 90, source: 'meta' },
    { weekday: 1, hour: 13, score: 40, source: 'meta' },
    { weekday: 2, hour: 20, score: 99, source: 'meta' },
  ]

  it('puts the client’s own slot ahead of anything analytics says', () => {
    const out = suggestTimes(MON, { slots, bestTimes: best })
    expect(out[0]).toMatchObject({ time: '19:30', source: 'slot', taken: false })
    expect(out[0].reason).toContain('Prime evening')
  })

  it('ranks analytics by strength and says where each came from', () => {
    const out = suggestTimes(MON, { slots, bestTimes: best })
    expect(out.map(s => s.time)).toEqual(['19:30', '21:00', '13:00'])
    expect(out[1].source).toBe('meta')
    expect(out[1].reason).toContain('followers online')
  })

  it('ignores evidence for a different weekday', () => {
    expect(suggestTimes(MON, { bestTimes: best }).map(s => s.time)).toEqual(['21:00', '13:00'])
  })

  it('pushes a taken slot to the end but still offers it', () => {
    const out = suggestTimes(MON, { slots, bestTimes: best, taken: ['19:30'] })
    expect(out.map(s => s.time)).toEqual(['21:00', '13:00', '19:30'])
    expect(out.at(-1)).toMatchObject({ time: '19:30', taken: true })
  })

  it('never offers the same clock time twice', () => {
    const out = suggestTimes(MON, {
      slots: [slot({ id: 's1', weekday: 1, time: '21:00' })],
      bestTimes: [{ weekday: 1, hour: 21, score: 99, source: 'meta' }],
    })
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('slot')
  })

  it('returns nothing rather than inventing a time', () => {
    expect(suggestTimes(SUN, { slots, bestTimes: best })).toEqual([])
  })
})

describe('defaultTimeFor', () => {
  const slots = [slot({ id: 's1', weekday: 1, time: '19:30' })]

  it('pre-fills a new plan row with the client’s slot', () => {
    expect(defaultTimeFor(MON, { slots })).toBe('19:30')
  })

  it('leaves the field blank rather than double-booking', () => {
    expect(defaultTimeFor(MON, { slots, taken: ['19:30'] })).toBeNull()
  })

  it('leaves it blank on a day with no plan and no evidence', () => {
    expect(defaultTimeFor(SUN, { slots })).toBeNull()
  })
})

describe('assignTimes', () => {
  const slots = [
    slot({ id: 'morning', weekday: 1, time: '09:00', priority: 0 }),
    slot({ id: 'evening', weekday: 1, time: '19:30', priority: 1 }),
  ]
  const item = (over: Partial<PlannableItem> & { id: string }): PlannableItem => ({ isoDate: MON, ...over })

  it('fills the client’s slots in priority order', () => {
    const r = assignTimes([item({ id: 'a' }), item({ id: 'b' })], slots)
    expect(r.assignments).toEqual([
      { itemId: 'a', isoDate: MON, time: '09:00', slotId: 'morning', source: 'slot' },
      { itemId: 'b', isoDate: MON, time: '19:30', slotId: 'evening', source: 'slot' },
    ])
  })

  it('gives the higher-priority poster the earlier slot', () => {
    const r = assignTimes(
      [item({ id: 'low', priority: 9 }), item({ id: 'high', priority: 1 })],
      slots,
    )
    expect(r.assignments.find(a => a.itemId === 'high')!.time).toBe('09:00')
    expect(r.assignments.find(a => a.itemId === 'low')!.time).toBe('19:30')
  })

  it('never double-books one slot', () => {
    const r = assignTimes([item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })], slots)
    const times = r.assignments.map(a => a.time)
    expect(new Set(times).size).toBe(times.length)
  })

  it('reports a poster it could not place instead of moving it to another day', () => {
    const r = assignTimes([item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })], slots)
    expect(r.assignments).toHaveLength(2)
    expect(r.unplaced).toEqual([{ itemId: 'c', isoDate: MON, reason: 'Every slot that day is already taken' }])
    expect(r.assignments.every(a => a.isoDate === MON)).toBe(true)
  })

  it('names the real reason when the weekday has no slot at all', () => {
    const r = assignTimes([item({ id: 'a', isoDate: SUN })], slots)
    expect(r.unplaced[0].reason).toBe('No posting slot set for Sunday')
  })

  it('leaves a poster that already has a time alone, and says so', () => {
    const r = assignTimes([item({ id: 'a', time: '11:00' })], slots)
    expect(r.assignments).toEqual([])
    expect(r.skipped).toEqual([{ itemId: 'a', reason: 'Already set for 11:00 am' }])
  })

  it('re-times an existing poster only when asked', () => {
    const r = assignTimes([item({ id: 'a', time: '11:00' })], slots, { overwrite: true })
    expect(r.assignments[0].time).toBe('09:00')
    expect(r.skipped).toEqual([])
  })

  it('never takes a slot away from a poster it is not re-timing', () => {
    const r = assignTimes([item({ id: 'fixed', time: '09:00' }), item({ id: 'new' })], slots)
    expect(r.assignments).toEqual([
      { itemId: 'new', isoDate: MON, time: '19:30', slotId: 'evening', source: 'slot' },
    ])
  })

  it('leaves a trending poster out of the schedule entirely', () => {
    const r = assignTimes([item({ id: 'hot', asap: true }), item({ id: 'a' })], slots)
    expect(r.skipped).toEqual([{ itemId: 'hot', reason: 'Posting as soon as it is ready' }])
    expect(r.assignments.map(a => a.itemId)).toEqual(['a'])
  })

  it('falls back to analytics when the slots run out', () => {
    const r = assignTimes(
      [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })],
      slots,
      { bestTimes: [{ weekday: 1, hour: 22, score: 80, source: 'meta' }] },
    )
    expect(r.assignments.find(a => a.itemId === 'c')).toMatchObject({ time: '22:00', source: 'meta' })
    expect(r.unplaced).toEqual([])
  })

  it('plans several days in one pass, each against its own weekday', () => {
    const withTue = [...slots, slot({ id: 'tue', weekday: 2, time: '18:00' })]
    const r = assignTimes([item({ id: 'mon' }), item({ id: 'tue', isoDate: TUE })], withTue)
    expect(r.assignments).toEqual([
      { itemId: 'mon', isoDate: MON, time: '09:00', slotId: 'morning', source: 'slot' },
      { itemId: 'tue', isoDate: TUE, time: '18:00', slotId: 'tue', source: 'slot' },
    ])
  })

  it('is stable: the same batch twice gives the same answer', () => {
    const batch = [item({ id: 'b' }), item({ id: 'a' })]
    expect(assignTimes(batch, slots)).toEqual(assignTimes(batch, slots))
  })
})

describe('postTiming', () => {
  const at = (iso: string) => new Date(iso)

  it('opens the warning window at the reminder lead, not at the minute itself', () => {
    // Post at 19:30 IST = 14:00Z.
    expect(postTiming({ isoDate: MON, time: '19:30' }, at('2026-10-19T13:44:00Z'))).toBe('today')
    expect(postTiming({ isoDate: MON, time: '19:30' }, at('2026-10-19T13:46:00Z'))).toBe('due_now')
  })

  it('keeps saying post-it-now through the grace period, not "you failed"', () => {
    expect(postTiming({ isoDate: MON, time: '19:30' }, at('2026-10-19T14:30:00Z'))).toBe('due_now')
    expect(postTiming({ isoDate: MON, time: '19:30' }, at('2026-10-19T14:46:00Z'))).toBe('overdue')
  })

  it('separates later today from another day', () => {
    expect(postTiming({ isoDate: MON, time: '23:00' }, at('2026-10-19T04:00:00Z'))).toBe('today')
    expect(postTiming({ isoDate: TUE, time: '19:30' }, at('2026-10-19T04:00:00Z'))).toBe('upcoming')
  })

  it('reads "today" on the India calendar, not the machine’s', () => {
    // 2026-10-19T19:00Z is already the 20th in India (00:30 IST).
    expect(postTiming({ isoDate: TUE, time: '23:00' }, at('2026-10-19T19:00:00Z'))).toBe('today')
  })

  it('calls out a poster with no time instead of pretending it is fine', () => {
    expect(postTiming({ isoDate: MON, time: null }, at('2026-10-19T04:00:00Z'))).toBe('untimed')
  })

  it('keeps ASAP and posted out of the clock entirely', () => {
    expect(postTiming({ isoDate: MON, time: null, asap: true }, at('2026-10-19T04:00:00Z'))).toBe('asap')
    expect(postTiming({ isoDate: MON, time: '19:30', posted: true }, at('2026-10-30T04:00:00Z'))).toBe('upcoming')
  })
})
