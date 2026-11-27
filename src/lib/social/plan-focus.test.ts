import { describe, it, expect } from 'vitest'
import {
  itemBucket, tallyPlan, urgency, openCount, shiftMonthKey, pickDefaultPlan,
  EMPTY_TALLY, type FocusItem, type FocusPlan, type PlanTally,
} from './plan-focus'

const TODAY = '2026-11-25'

const item = (over: Partial<FocusItem>): FocusItem => ({
  scheduled_date: '2026-11-28', status: 'planned', request_id: null, task_id: null, ...over,
})

describe('itemBucket', () => {
  it('folds the pipeline into done / active / planned / late', () => {
    expect(itemBucket('done', { scheduled_date: '2026-11-03' }, TODAY)).toBe('done')
    // Delivered is with the client — done, even though its date has passed.
    expect(itemBucket('delivered', { scheduled_date: '2026-11-03' }, TODAY)).toBe('done')
    expect(itemBucket('planned', { scheduled_date: '2026-11-28' }, TODAY)).toBe('planned')
    expect(itemBucket('requested', { scheduled_date: '2026-11-28' }, TODAY)).toBe('active')
    expect(itemBucket('in_progress', { scheduled_date: '2026-11-10' }, TODAY)).toBe('late')
    expect(itemBucket('cancelled', { scheduled_date: '2026-11-10' }, TODAY)).toBeNull()
  })

  it('does not call today late, and waits for a campaign to end', () => {
    expect(itemBucket('planned', { scheduled_date: TODAY }, TODAY)).toBe('planned')
    expect(itemBucket('planned', { scheduled_date: '2026-11-20', scheduled_end_date: '2026-11-27' }, TODAY)).toBe('planned')
    expect(itemBucket('planned', { scheduled_date: '2026-11-17', scheduled_end_date: '2026-11-20' }, TODAY)).toBe('late')
  })
})

describe('tallyPlan', () => {
  it('counts dated, live items and what is still to send', () => {
    const t = tallyPlan([
      item({ scheduled_date: '2026-11-03', status: 'requested', request_id: 'r1', request: { status: 'completed' } }),
      item({ scheduled_date: '2026-11-10' }),                                       // late, unsent
      item({ scheduled_date: '2026-11-26', status: 'requested', request_id: 'r2', request: { status: 'submitted' } }),
      item({ scheduled_date: '2026-11-28' }),                                       // planned, unsent
      item({ scheduled_date: '2026-11-19', status: 'cancelled' }),                  // not counted
      item({ scheduled_date: null }),                                               // idea, not counted
    ], TODAY)
    expect(t).toEqual({ total: 4, done: 1, active: 1, planned: 1, late: 1, toSend: 2 })
    expect(openCount(t)).toBe(3)
  })

  it('treats an item a task holds directly as sent', () => {
    const t = tallyPlan([item({ task_id: 't1', task: { status: 'in_progress' } })], TODAY)
    expect(t).toMatchObject({ active: 1, toSend: 0 })
  })
})

describe('urgency', () => {
  it('ranks late above unsent above in-hand', () => {
    const t = (over: Partial<PlanTally>) => urgency({ ...EMPTY_TALLY, ...over })
    expect(t({ late: 1 })).toBeGreaterThan(t({ toSend: 1 }))
    expect(t({ toSend: 1 })).toBeGreaterThan(t({ active: 1 }))
    // One late post outranks any amount of unsent work.
    expect(t({ late: 1 })).toBeGreaterThan(t({ toSend: 40, active: 40 }))
    expect(t({ done: 9 })).toBe(0)
  })
})

describe('shiftMonthKey', () => {
  it('steps across a year end', () => {
    expect(shiftMonthKey('2026-11', 1)).toBe('2026-12')
    expect(shiftMonthKey('2026-12', 1)).toBe('2027-01')
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12')
  })
})

describe('pickDefaultPlan', () => {
  const plan = (id: string, month: string, clientName = id, status: FocusPlan['status'] = 'active'): FocusPlan =>
    ({ id, month: `${month}-01`, status, clientName })
  const tally = (over: Partial<PlanTally>): PlanTally => ({ ...EMPTY_TALLY, ...over })
  const plans = [
    plan('dec-a', '2026-12'), plan('nov-a', '2026-11'), plan('nov-b', '2026-11'),
    plan('oct-a', '2026-10'), plan('sep-a', '2026-09', 'sep-a', 'archived'),
  ]
  const tallies = {
    'dec-a': tally({ total: 19, planned: 19, toSend: 19 }),
    'nov-a': tally({ total: 12, done: 9, active: 3 }),
    'nov-b': tally({ total: 4, late: 1, planned: 3, toSend: 4 }),
    'oct-a': tally({ total: 12, done: 12 }),
  }
  const pick = (lastOpenedId: string | null, over: Partial<Parameters<typeof pickDefaultPlan>[0]> = {}) =>
    pickDefaultPlan({ plans, tallies, lastOpenedId, thisMonth: '2026-11', ...over })

  it('opens the plan last opened while it is still current', () => {
    expect(pick('dec-a')).toBe('dec-a')
    expect(pick('nov-a')).toBe('nov-a')
  })

  it('lets go of a finished past month, an archived plan and a deleted one', () => {
    expect(pick('oct-a')).toBe('nov-b')
    expect(pick('sep-a')).toBe('nov-b')
    expect(pick('gone')).toBe('nov-b')
  })

  it('keeps a past month that still has open work', () => {
    expect(pick('oct-a', { tallies: { ...tallies, 'oct-a': tally({ total: 12, done: 10, late: 2 }) } })).toBe('oct-a')
  })

  it('with nothing remembered, opens the most urgent plan of this month', () => {
    // nov-b has late and unsent work; December has more to send but is not this month.
    expect(pick(null)).toBe('nov-b')
  })

  it('falls forward to the nearest month, then back to the latest past one', () => {
    const noNov = plans.filter(p => !p.id.startsWith('nov'))
    expect(pick(null, { plans: noNov })).toBe('dec-a')
    expect(pick(null, { plans: noNov.filter(p => p.id !== 'dec-a') })).toBe('oct-a')
  })

  it('works without tallies, and with no plans at all', () => {
    expect(pick(null, { tallies: {} })).toBe('nov-a')
    expect(pick(null, { plans: [plans[4]] })).toBe('sep-a')
    expect(pick(null, { plans: [] })).toBeNull()
  })
})
