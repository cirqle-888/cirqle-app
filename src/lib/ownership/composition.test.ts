import { describe, it, expect } from 'vitest'
import { buildComposition, singleRate } from './composition'
import type { BasisLine } from './types'

const line = (o: Partial<BasisLine>): BasisLine => ({
  clientId: 'c1', taskId: 't1', taskNumber: 1, title: 'Poster',
  serviceId: 's1', date: '2026-08-04', amountInr: 500, ...o,
})

describe('singleRate', () => {
  it('returns the rate when every award shares one', () => {
    expect(singleRate([2, 2, 2])).toBe(2)
  })

  it('returns null when participants earn at different rates', () => {
    expect(singleRate([2, 3])).toBeNull()
  })

  it('returns null for a fixed-amount award, which has no percentage', () => {
    expect(singleRate([null])).toBeNull()
  })

  it('returns null for no awards at all', () => {
    expect(singleRate([])).toBeNull()
  })
})

describe('buildComposition', () => {
  it('groups by client, biggest first, and shares sum to the whole', () => {
    const c = buildComposition([
      line({ clientId: 'c1', amountInr: 500 }),
      line({ clientId: 'c1', amountInr: 300, taskId: 't2' }),
      line({ clientId: 'c2', amountInr: 1200, taskId: 't3' }),
    ], 2)

    expect(c.totalInr).toBe(2000)
    expect(c.lineCount).toBe(3)
    expect(c.clients.map(g => [g.clientId, g.totalInr, g.sharePct])).toEqual([
      ['c2', 1200, 60], ['c1', 800, 40],
    ])
    expect(c.clients.reduce((s, g) => s + g.sharePct, 0)).toBe(100)
  })

  it('applies the rate so the parts add up to the award', () => {
    const c = buildComposition([
      line({ clientId: 'c1', amountInr: 500 }),
      line({ clientId: 'c2', amountInr: 1500, taskId: 't2' }),
    ], 2)
    expect(c.clients.map(g => g.earnedInr)).toEqual([30, 10])
    expect(c.clients.reduce((s, g) => s + (g.earnedInr ?? 0), 0)).toBe(40)   // 2% of 2000
  })

  it('shows shares but no rupee split when participants earn at different rates', () => {
    const c = buildComposition([line({ amountInr: 500 })], null)
    expect(c.ratePercent).toBeNull()
    expect(c.clients[0].earnedInr).toBeNull()
    expect(c.clients[0].lines[0].earnedInr).toBeNull()
    expect(c.clients[0].sharePct).toBe(100)
  })

  it('keeps clientless money in its own group instead of dropping it', () => {
    const c = buildComposition([
      line({ clientId: 'c1', amountInr: 600 }),
      line({ clientId: null, amountInr: 400, taskId: 't2' }),
    ], 2)
    expect(c.totalInr).toBe(1000)
    expect(c.clients.map(g => g.clientId)).toEqual(['c1', null])
    expect(c.clients[1].totalInr).toBe(400)
  })

  it('sorts a client\'s own lines by amount, newest first on a tie', () => {
    const c = buildComposition([
      line({ taskId: 'a', amountInr: 100, date: '2026-08-01' }),
      line({ taskId: 'b', amountInr: 900, date: '2026-08-02' }),
      line({ taskId: 'c', amountInr: 100, date: '2026-08-09' }),
    ], null)
    expect(c.clients[0].lines.map(l => l.taskId)).toEqual(['b', 'c', 'a'])
  })

  it('survives a zero-billing period without dividing by zero', () => {
    const c = buildComposition([line({ amountInr: 0 })], 2)
    expect(c.totalInr).toBe(0)
    expect(c.clients[0].sharePct).toBe(0)
    expect(c.clients[0].earnedInr).toBe(0)
  })

  it('returns an empty composition for no lines', () => {
    const c = buildComposition([], 2)
    expect(c).toMatchObject({ totalInr: 0, lineCount: 0, clients: [] })
  })
})
