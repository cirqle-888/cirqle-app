import { describe, it, expect } from 'vitest'
import { allocateCapitalShare, balanceOn, capitalDays, daysInclusive } from './capital'
import type { CapitalMovement } from './types'

const mv = (over: Partial<CapitalMovement>): CapitalMovement => ({
  id: Math.random().toString(36).slice(2), memberId: 'founder', direction: 'in', amountInr: 0,
  weight: 1, effectiveOn: '2026-01-01', status: 'approved', ...over,
})

describe('capital-days (design §7.3)', () => {
  const movements = [
    mv({ memberId: 'founder', amountInr: 500000, effectiveOn: '2026-01-01' }),
    mv({ memberId: 'emp', amountInr: 100000, effectiveOn: '2026-07-01' }),
  ]

  it('counts the period days', () => {
    expect(daysInclusive('2026-04-01', '2026-09-30')).toBe(183)
  })

  it('reproduces the worked example to the paisa', () => {
    expect(capitalDays(movements, 'founder', '2026-04-01', '2026-09-30')).toBe(91500000)
    expect(capitalDays(movements, 'emp', '2026-04-01', '2026-09-30')).toBe(9200000)
    const a = allocateCapitalShare(25000, movements, ['founder', 'emp'], '2026-04-01', '2026-09-30')
    expect(a.entitlements.map(e => [e.memberId, e.amountInr])).toEqual([['founder', 22715.99], ['emp', 2284.01]])
    expect(a.entitlements.reduce((s, e) => s + e.amountInr, 0)).toBeCloseTo(25000, 2)
  })

  it('nets money in and out on the same day', () => {
    const m = [mv({ amountInr: 1000, effectiveOn: '2026-05-01' }), mv({ direction: 'out', amountInr: 1000, effectiveOn: '2026-05-01' })]
    expect(capitalDays(m, 'founder', '2026-04-01', '2026-09-30')).toBe(0)
  })

  it('stops counting from the day of a withdrawal', () => {
    const m = [mv({ amountInr: 1000, effectiveOn: '2026-01-01' }), mv({ direction: 'out', amountInr: 400, effectiveOn: '2026-04-11' })]
    // 10 days at 1,000, then 20 days at 600 (April has 30 days)
    expect(capitalDays(m, 'founder', '2026-04-01', '2026-04-30')).toBe(10 * 1000 + 20 * 600)
    expect(balanceOn(m, 'founder', '2026-04-30')).toBe(600)
  })

  it('ignores movements that are pending or rejected', () => {
    const m = [mv({ amountInr: 1000, status: 'pending_approval' }), mv({ amountInr: 500, status: 'rejected' })]
    expect(capitalDays(m, 'founder', '2026-04-01', '2026-04-30')).toBe(0)
  })

  it('weights capital when an agreement says so', () => {
    const m = [mv({ amountInr: 1000, weight: 0.5 })]
    expect(capitalDays(m, 'founder', '2026-04-01', '2026-04-30')).toBe(15000)
  })

  it('leaves the Capital Share unallocated when nobody holds capital', () => {
    const a = allocateCapitalShare(25000, [], ['founder'], '2026-04-01', '2026-09-30')
    expect(a.entitlements).toEqual([])
    expect(a.unallocatedInr).toBe(25000)
  })
})
