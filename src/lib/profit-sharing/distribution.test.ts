import { describe, it, expect } from 'vitest'
import { carryLoss, distribute, validateSettings } from './distribution'

describe('carryLoss (design §7.1)', () => {
  it('absorbs losses before anything becomes eligible', () => {
    const p1 = carryLoss(0, -40000)
    expect(p1).toMatchObject({ lossOffsetInr: 0, closingLossInr: 40000, eligibleProfitInr: 0 })
    const p2 = carryLoss(p1.closingLossInr, 25000)
    expect(p2).toMatchObject({ lossOffsetInr: 25000, closingLossInr: 15000, eligibleProfitInr: 0 })
    const p3 = carryLoss(p2.closingLossInr, 115000)
    expect(p3).toMatchObject({ lossOffsetInr: 15000, closingLossInr: 0, eligibleProfitInr: 100000 })
  })

  it('treats a result of exactly zero as neither profit nor loss', () => {
    expect(carryLoss(5000, 0)).toMatchObject({ lossOffsetInr: 0, closingLossInr: 5000, eligibleProfitInr: 0 })
  })
})

describe('distribute (design §7.2, confirmed 50 / 50 / 50)', () => {
  const s = { distributionPct: 50, capitalSharePct: 50 }

  it('reproduces the ₹1,00,000 example', () => {
    expect(distribute(100000, s)).toEqual({
      eligibleProfitInr: 100000, poolInr: 50000, capitalShareInr: 25000, reserveInr: 25000,
      retainedOutsideInr: 50000, totalRetainedInr: 75000,
    })
  })

  it('always adds up to the paisa, whatever the percentages', () => {
    for (const [e, d, c] of [[12345.67, 33.33, 61.11], [1, 50, 50], [999999.99, 12.5, 87.5], [0.03, 50, 50]]) {
      const r = distribute(e, { distributionPct: d, capitalSharePct: c })
      expect(Math.round((r.capitalShareInr + r.reserveInr) * 100)).toBe(Math.round(r.poolInr * 100))
      expect(Math.round((r.poolInr + r.retainedOutsideInr) * 100)).toBe(Math.round(r.eligibleProfitInr * 100))
    }
  })

  it('distributes nothing when nothing is eligible', () => {
    expect(distribute(0, s).poolInr).toBe(0)
  })
})

describe('validateSettings', () => {
  it('accepts the initial settings', () => {
    expect(validateSettings({ distributionPct: 50, capitalSharePct: 50, reservePct: 50 })).toEqual([])
  })

  it('refuses a Capital/Reserve split that is not exactly 100%', () => {
    expect(validateSettings({ distributionPct: 50, capitalSharePct: 60, reservePct: 30 }))
      .toContain('Capital Share and Business Reserve must total exactly 100%')
    expect(validateSettings({ distributionPct: 50, capitalSharePct: 33.33, reservePct: 66.67 })).toEqual([])
  })

  it('refuses out-of-range and over-precise percentages', () => {
    expect(validateSettings({ distributionPct: 120, capitalSharePct: 50, reservePct: 50 })).toContain('Distribution rate must be between 0 and 100')
    expect(validateSettings({ distributionPct: 50.123, capitalSharePct: 50, reservePct: 50 })).toContain('Distribution rate can have at most 2 decimals')
  })

  it('refuses a non-positive ageing threshold', () => {
    expect(validateSettings({ distributionPct: 50, capitalSharePct: 50, reservePct: 50, adPrepaidBlockDays: 0 }))
      .toContain('Ad-funding block must be a whole number of days above 0')
  })
})
