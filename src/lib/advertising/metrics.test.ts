import { describe, it, expect } from 'vitest'
import {
  ctr, cpc, cpm, roas, frequency, costPerResult, remainingBudget,
  primaryResult, deriveMetrics, aggregateMetrics,
} from './metrics'

describe('derived metric formulas', () => {
  it('computes CTR as a percentage', () => {
    expect(ctr(50, 1000)).toBe(5)        // 50/1000 = 5%
    expect(ctr(0, 1000)).toBe(0)
  })
  it('computes CPC, CPM, ROAS, frequency', () => {
    expect(cpc(200, 50)).toBe(4)         // 200/50
    expect(cpm(200, 1000)).toBe(200)     // 200/1000*1000
    expect(roas(3000, 1000)).toBe(3)     // 3x
    expect(frequency(3000, 1000)).toBe(3)
  })
  it('returns null on a zero/missing denominator (no NaN/Infinity)', () => {
    expect(ctr(50, 0)).toBeNull()
    expect(cpc(200, 0)).toBeNull()
    expect(cpm(200, null)).toBeNull()
    expect(roas(3000, 0)).toBeNull()
    expect(frequency(3000, undefined)).toBeNull()
    expect(costPerResult(100, 0)).toBeNull()
  })
  it('remaining budget can go negative to signal overspend', () => {
    expect(remainingBudget(20000, 15000)).toBe(5000)
    expect(remainingBudget(20000, 22000)).toBe(-2000)
    expect(remainingBudget(null, 100)).toBeNull()
  })
})

describe('primaryResult by campaign objective', () => {
  const row = { leads: 10, messages: 5, purchases: 3, conversions: 8, clicks: 100, video_views: 400 }
  it('picks the objective-matching count', () => {
    expect(primaryResult(row, 'leads')).toBe(10)
    expect(primaryResult(row, 'messages')).toBe(5)
    expect(primaryResult(row, 'sales')).toBe(3)
    expect(primaryResult(row, 'video_views')).toBe(400)
    expect(primaryResult(row, 'traffic')).toBe(100)
  })
  it('falls back sensibly for unknown objective', () => {
    expect(primaryResult(row, undefined)).toBe(8) // conversions first
    // 'leads' only considers leads/conversions; neither present → null
    expect(primaryResult({ clicks: 7 }, 'leads')).toBeNull()
    // unknown objective falls through to clicks when nothing else is present
    expect(primaryResult({ clicks: 7 }, undefined)).toBe(7)
  })
})

describe('deriveMetrics', () => {
  it('fills blank derived metrics but preserves entered values', () => {
    const d = deriveMetrics(
      { spend: 1000, impressions: 10000, clicks: 200, revenue: 4000 },
      'sales',
    )
    expect(d.ctr).toBe(2)       // 200/10000
    expect(d.cpc).toBe(5)       // 1000/200
    expect(d.roas).toBe(4)      // 4000/1000
  })
  it('keeps an Ads-Manager-entered ratio over the computed one', () => {
    const d = deriveMetrics({ spend: 1000, impressions: 10000, clicks: 200, ctr: 1.8 })
    expect(d.ctr).toBe(1.8)     // entered value wins, not 2
  })
})

describe('aggregateMetrics', () => {
  it('sums raw values and recomputes ratios from the sums', () => {
    const agg = aggregateMetrics([
      { spend: 500, impressions: 5000, clicks: 100, revenue: 1500, leads: 5 },
      { spend: 500, impressions: 5000, clicks: 100, revenue: 1500, leads: 5 },
    ])
    expect(agg.days).toBe(2)
    expect(agg.spend).toBe(1000)
    expect(agg.clicks).toBe(200)
    expect(agg.leads).toBe(10)
    expect(agg.ctr).toBe(2)     // 200/10000, NOT an average of daily CTRs
    expect(agg.roas).toBe(3)    // 3000/1000
  })
  it('handles an empty period without dividing by zero', () => {
    const agg = aggregateMetrics([])
    expect(agg.days).toBe(0)
    expect(agg.spend).toBe(0)
    expect(agg.ctr).toBeNull()
  })
})
