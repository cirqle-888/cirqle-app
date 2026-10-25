/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
import { describe, it, expect } from 'vitest'
import { expectedSpendForPeriod } from './pacing'
import { calculateWeightedHealthScore } from '@/lib/advertising/ai/scoring'

describe('expectedSpendForPeriod', () => {
  const base = { budget: 3000, campaignStart: '2026-10-01', campaignEnd: '2026-10-30' }
  it('first week of a 30-day campaign expects 7/30 of budget', () => {
    expect(expectedSpendForPeriod({ ...base, periodFrom: '2026-10-01', periodTo: '2026-10-07', today: '2026-10-24' })).toBeCloseTo(700, 6)
  })
  it('does not expect spend for days that have not happened', () => {
    expect(expectedSpendForPeriod({ ...base, periodFrom: '2026-10-01', periodTo: '2026-10-30', today: '2026-10-10' })).toBeCloseTo(1000, 6)
  })
  it('null without dates or budget', () => {
    expect(expectedSpendForPeriod({ ...base, campaignEnd: null, periodFrom: '2026-10-01', periodTo: '2026-10-07', today: '2026-10-24' })).toBeNull()
    expect(expectedSpendForPeriod({ ...base, budget: 0, periodFrom: '2026-10-01', periodTo: '2026-10-07', today: '2026-10-24' })).toBeNull()
  })
})

const noBench = { roas: 0, cpc: 0, ctr: 0, cpa: 0, cpm: 0, conversion_rate: 0, margin: 0 }

describe('calculateWeightedHealthScore', () => {
  it('a new awareness campaign with no revenue tracking is not failed on ROAS', () => {
    const h = calculateWeightedHealthScore(
      { spend: 700, budget: 3000, roas: 0, ctr: 1.1, cpc: 5, cpa: 0, conversion_rate: 0, revenueTracked: false, results: null, expectedSpend: 700 },
      noBench,
      { roas: { predicted_value: 0, trend: 'down', confidence: 50 } as any },
    )
    expect(h.explanations.join(' ')).not.toMatch(/ROAS/)
    // Only pacing could be judged: no grade, but the pacing note remains.
    expect(h.insufficientData).toBe(true)
    expect(h.explanations.join(' ')).toMatch(/pacing is on track/i)
  })
  it('reports insufficient data when nothing can be judged', () => {
    const h = calculateWeightedHealthScore(
      { spend: 0, budget: 0, roas: 0, ctr: 0, cpc: 0, cpa: 0, conversion_rate: 0, revenueTracked: false, results: null, expectedSpend: null },
      noBench,
    )
    expect(h.insufficientData).toBe(true)
  })
  it('still grades ROAS when revenue is tracked', () => {
    const h = calculateWeightedHealthScore(
      { spend: 1000, budget: 1000, roas: 0.3, ctr: 1, cpc: 5, cpa: 0, conversion_rate: 0, revenueTracked: true },
      { ...noBench, roas: 2 },
    )
    expect(h.explanations.join(' ')).toMatch(/Critical absolute ROAS/)
  })
})
