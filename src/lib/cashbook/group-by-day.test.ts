import { describe, it, expect } from 'vitest'
import { groupByDay, dayGroupLabel } from './group-by-day'

interface Row { id: string; entry_date: string | null; amount: number; type: 'inflow' | 'outflow' }

const fields = {
  date: (r: Row) => r.entry_date,
  amount: (r: Row) => r.amount,
  isInflow: (r: Row) => r.type === 'inflow',
}

const row = (id: string, entry_date: string | null, amount: number, type: Row['type'] = 'outflow'): Row =>
  ({ id, entry_date, amount, type })

const ids = (rows: Row[]) => rows.map(r => r.id)

describe('groupByDay', () => {
  it('puts each calendar day in its own group', () => {
    const groups = groupByDay([
      row('a', '2026-10-10', 371),
      row('b', '2026-10-09', 1200, 'inflow'),
      row('c', '2026-10-09', 5353),
    ], fields)

    expect(groups.map(g => g.key)).toEqual(['2026-10-10', '2026-10-09'])
    expect(ids(groups[1].rows)).toEqual(['b', 'c'])
  })

  it('keeps the list’s own order, rather than imposing one', () => {
    // The toolbar offers newest-first and oldest-first; grouping must not
    // quietly disagree with whichever is set.
    const oldestFirst = groupByDay([
      row('a', '2026-01-01', 10),
      row('b', '2026-06-01', 10),
      row('c', '2026-12-01', 10),
    ], fields)
    expect(oldestFirst.map(g => g.key)).toEqual(['2026-01-01', '2026-06-01', '2026-12-01'])
  })

  it('totals each side of the day separately', () => {
    const [day] = groupByDay([
      row('a', '2026-10-09', 1200, 'inflow'),
      row('b', '2026-10-09', 5353),
      row('c', '2026-10-09', 420),
    ], fields)
    expect(day.inflow).toBe(1200)
    expect(day.outflow).toBe(5773)
    expect(day.net).toBe(-4573)
  })

  it('takes direction from the type, not from the sign of the amount', () => {
    // An outflow reaches the client stored either way depending on where the
    // row came from; `isInflow` is the authority.
    const [day] = groupByDay([
      row('a', '2026-10-09', -500),
      row('b', '2026-10-09', 500, 'inflow'),
    ], fields)
    expect(day.outflow).toBe(500)
    expect(day.inflow).toBe(500)
    expect(day.net).toBe(0)
  })

  it('groups a timestamp with the day it falls on', () => {
    const groups = groupByDay([
      row('a', '2026-10-09T23:40:00+05:30', 10),
      row('b', '2026-10-09', 10),
    ], fields)
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('2026-10-09')
  })

  it('collects undated rows under one group, placed last', () => {
    const groups = groupByDay([
      row('a', null, 10),
      row('b', '2026-10-09', 10),
      row('c', '', 10),
    ], fields)
    expect(groups.map(g => g.key)).toEqual(['2026-10-09', ''])
    expect(ids(groups[1].rows)).toEqual(['a', 'c'])
  })

  it('survives a malformed date without losing the row', () => {
    const groups = groupByDay([row('a', 'not a date', 10)], fields)
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('')
    expect(groups[0].rows).toHaveLength(1)
  })

  it('treats a non-numeric amount as zero rather than NaN', () => {
    const [day] = groupByDay([{ id: 'a', entry_date: '2026-10-09', amount: NaN, type: 'outflow' }], fields)
    expect(day.outflow).toBe(0)
    expect(day.net).toBe(0)
  })

  it('has nothing to group when there is nothing', () => {
    expect(groupByDay([], fields)).toEqual([])
  })
})

describe('dayGroupLabel', () => {
  it('names today and yesterday', () => {
    expect(dayGroupLabel('2026-10-13', '2026-10-13')).toBe('Today')
    expect(dayGroupLabel('2026-10-12', '2026-10-13')).toBe('Yesterday')
  })

  it('crosses a month boundary when naming yesterday', () => {
    expect(dayGroupLabel('2026-09-30', '2026-10-01')).toBe('Yesterday')
  })

  it('crosses a year boundary too', () => {
    expect(dayGroupLabel('2025-12-31', '2026-01-01')).toBe('Yesterday')
  })

  it('spells out any other day', () => {
    expect(dayGroupLabel('2026-10-09')).toBe('Friday, 9 October 2026')
  })

  it('does not read a calendar date through a timezone', () => {
    // The whole point: the label must match the date printed on the row, for
    // a reader anywhere in the world.
    expect(dayGroupLabel('2026-01-01')).toContain('1 January 2026')
  })

  it('says so when there is no date', () => {
    expect(dayGroupLabel('')).toBe('No date')
  })

  it('falls back to the raw value rather than inventing a day', () => {
    expect(dayGroupLabel('2026-13-99')).toBe('2026-13-99')
  })
})

describe('groupByDay — cash-flow contribution', () => {
  interface FlowRow extends Row { transfer_ref?: string | null; reversal_of?: string | null }

  it('lists transfer legs but leaves them out of the day totals, and nets reversals', async () => {
    const { cashFlowContribution } = await import('@/lib/finance/cash-flow')
    const rows: FlowRow[] = [
      { ...row('t-out', '2026-10-09', 50000), transfer_ref: 't' },
      { ...row('t-in', '2026-10-09', 50000, 'inflow'), transfer_ref: 't' },
      row('sal', '2026-10-09', 5353),
      { ...row('sal-back', '2026-10-09', 5353, 'inflow'), reversal_of: 'sal' },
      row('fee', '2026-10-09', 3),
    ]
    const [day] = groupByDay(rows, {
      ...fields,
      contribution: r => cashFlowContribution({ type: r.type, amount_inr: r.amount, transfer_ref: r.transfer_ref, reversal_of: r.reversal_of }),
    })
    expect(day.rows).toHaveLength(5)
    expect(day.inflow).toBe(0)
    expect(day.outflow).toBe(3)
    expect(day.net).toBe(-3)
  })
})
