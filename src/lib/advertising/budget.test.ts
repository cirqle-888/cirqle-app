import { describe, it, expect } from 'vitest'
import {
  computeServiceCharge, computeBudgetTotals, daysBetween, daysForDuration, resolveAdSpend,
} from './budget'

describe('computeServiceCharge', () => {
  it('returns the fixed amount as-is', () => {
    expect(computeServiceCharge(20000, 'fixed', 3000)).toBe(3000)
  })
  it('computes a percent of the ad budget', () => {
    expect(computeServiceCharge(20000, 'percent', 15)).toBe(3000) // 15% of 20k
  })
})

describe('computeBudgetTotals', () => {
  it('derives subtotal, tax and grand total (PRD example: ₹20k + 15%)', () => {
    const t = computeBudgetTotals({
      adBudget: 20000, serviceChargeType: 'percent', serviceChargeValue: 15, taxPercent: 18,
    })
    expect(t.adSpend).toBe(20000)
    expect(t.serviceCharge).toBe(3000)
    expect(t.subtotal).toBe(23000)
    expect(t.tax).toBe(4140)         // 18% of 23000
    expect(t.grandTotal).toBe(27140)
  })
  it('handles a fixed fee with no tax', () => {
    const t = computeBudgetTotals({
      adBudget: 35000, serviceChargeType: 'fixed', serviceChargeValue: 5000,
    })
    expect(t.subtotal).toBe(40000)
    expect(t.tax).toBe(0)
    expect(t.grandTotal).toBe(40000)
  })
  it('rounds to 2 decimals', () => {
    const t = computeBudgetTotals({
      adBudget: 10000, serviceChargeType: 'percent', serviceChargeValue: 12.5, taxPercent: 5,
    })
    expect(t.serviceCharge).toBe(1250)
    expect(t.subtotal).toBe(11250)
    expect(t.tax).toBe(562.5)
    expect(t.grandTotal).toBe(11812.5)
  })
})

describe('daysBetween', () => {
  it('counts inclusively', () => {
    expect(daysBetween('2026-06-01', '2026-06-07')).toBe(7)
    expect(daysBetween('2026-06-01', '2026-06-01')).toBe(1)
  })
  it('returns 0 for missing or reversed ranges', () => {
    expect(daysBetween(null, '2026-06-07')).toBe(0)
    expect(daysBetween('2026-06-10', '2026-06-01')).toBe(0)
  })
})

describe('daysForDuration', () => {
  it('maps numeric presets', () => {
    expect(daysForDuration('7')).toBe(7)
    expect(daysForDuration('30')).toBe(30)
  })
  it('uses the date range for custom', () => {
    expect(daysForDuration('custom', '2026-06-01', '2026-06-30')).toBe(30)
    expect(daysForDuration('custom', null, null)).toBe(0)
  })
})

describe('resolveAdSpend', () => {
  it('passes a direct total through', () => {
    expect(resolveAdSpend({ mode: 'total', adBudget: 20000 })).toEqual({ adSpend: 20000, days: 0 })
  })
  it('multiplies daily budget by a preset duration', () => {
    expect(resolveAdSpend({ mode: 'daily', dailyBudget: 3000, durationPreset: '7' }))
      .toEqual({ adSpend: 21000, days: 7 })
  })
  it('multiplies daily budget across a custom date range (inclusive)', () => {
    expect(resolveAdSpend({
      mode: 'daily', dailyBudget: 1000, durationPreset: 'custom',
      startDate: '2026-06-01', endDate: '2026-06-30',
    })).toEqual({ adSpend: 30000, days: 30 })
  })
  it('is 0 when a daily range has no dates', () => {
    expect(resolveAdSpend({ mode: 'daily', dailyBudget: 1000, durationPreset: 'custom' }))
      .toEqual({ adSpend: 0, days: 0 })
  })
})
