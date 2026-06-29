import { describe, it, expect } from 'vitest'
import { healthScore } from './health'

describe('healthScore', () => {
  it('returns a neutral Unknown when there is nothing to score', () => {
    const h = healthScore({})
    expect(h.label).toBe('Unknown')
    expect(h.score).toBe(50)
  })

  it('scores a strong, on-pace campaign highly', () => {
    const h = healthScore({
      adBudget: 20000, totalSpend: 10000,
      startDate: '2026-06-01', endDate: '2026-06-30', asOf: '2026-06-15',
      roas: 4, ctr: 2,
    })
    expect(h.score).toBeGreaterThanOrEqual(80)
    expect(h.label).toBe('Excellent')
  })

  it('penalizes a poor, overspending campaign', () => {
    const h = healthScore({
      adBudget: 20000, totalSpend: 40000,
      startDate: '2026-06-01', endDate: '2026-06-30', asOf: '2026-06-10',
      roas: 0.3, ctr: 0.2,
    })
    expect(h.score).toBeLessThan(40)
    expect(h.label).toBe('Poor')
  })

  it('renormalizes weights when only some signals are present', () => {
    const h = healthScore({ roas: 4 }) // only ROAS available
    expect(h.factors).toHaveLength(1)
    expect(h.score).toBe(100) // roasScore(4) = 100, sole factor
  })
})
