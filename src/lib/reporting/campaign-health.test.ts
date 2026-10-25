import { describe, it, expect } from 'vitest'
import { assessCampaignHealth, healthLabel } from './campaign-health'

const base = {
  spend: 169.48, revenue: 0, roas: 0, ctr: 2.17, cpc: 2.42, conversionRate: 0,
  results: 2, costPerResult: 84.74, budget: 0,
  campaignStart: null, campaignEnd: null, periodFrom: '2026-10-24', periodTo: '2026-10-25', today: '2026-10-25',
}
const bench = { roas: 0, cpc: 3, ctr: 1.5, cpa: 100, cpm: 0, conversion_rate: 0, margin: 0 }

describe('assessCampaignHealth', () => {
  it('a messaging campaign with no revenue is not marked "Poor" on ROAS', () => {
    const h = assessCampaignHealth({ ...base, benchmarks: null, benchmarkSource: null })
    expect(h.insufficientData).toBe(true)
    expect(healthLabel(h)).toBe('Not graded')
    expect(h.explanations.join(' ')).not.toMatch(/ROAS/)
  })

  it('placeholder benchmarks are never graded against', () => {
    const h = assessCampaignHealth({ ...base, benchmarks: bench, benchmarkSource: 'global' })
    expect(h.insufficientData).toBe(true)
  })

  it('a real benchmark grades cost per conversation', () => {
    const h = assessCampaignHealth({ ...base, benchmarks: bench, benchmarkSource: 'client' })
    expect(h.insufficientData).toBeUndefined()
    expect(h.explanations.join(' ')).toMatch(/Cost per result is 15% below benchmark/)
    expect(healthLabel(h)).toMatch(/^Grade [A-F] · \d+\/100$/)
  })
})
