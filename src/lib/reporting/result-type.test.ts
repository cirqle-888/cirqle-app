import { describe, it, expect } from 'vitest'
import { resultDefinitionFor, resultCount, costPerSelectedResult, pctChange } from './result-type'
import { buildKPIData } from './kpi-engine'
import type { ReportMetricRow, ReportProject } from './types'

const row = (date: string, o: Partial<ReportMetricRow>): ReportMetricRow => ({
  date, spend: 0, revenue: 0, impressions: 0, clicks: 0, reach: 0, leads: 0, conversions: 0,
  messages: null, purchases: null, landingPageViews: null, exchangeRate: 1, ...o,
})
const project = (o: Partial<ReportProject> = {}): ReportProject => ({
  id: 'p', clientId: 'c', clientName: 'C', clientCode: 'C', campaignName: 'X', platform: 'meta',
  campaignType: 'leads', status: 'active', adBudget: 0, adBudgetCurrency: 'INR', serviceChargeType: null,
  serviceChargeValue: 0, taxPercent: 0, budgetInputMode: 'total', dailyBudgetConfigured: null,
  budgetDaysConfigured: null, objective: null, startDate: null, endDate: null, walletAllocation: 0, ...o,
} as ReportProject)

describe('result definitions', () => {
  it('₹500, 0 leads, 50 clicks → CPL unavailable, not a click cost', () => {
    const k = buildKPIData([row('2026-10-01', { spend: 500, clicks: 50 })], [], project({ campaignType: 'leads' }))
    expect(k.derived.results).toBe(0)
    expect(k.derived.costPerResult).toBeNull()
    expect(k.primary.cpc).toBe(10)
    expect(k.dailySeries[0].cpr).toBeNull()
  })

  it('awareness has no cost per result', () => {
    const k = buildKPIData([row('2026-10-01', { spend: 500, clicks: 50, impressions: 10000 })], [], project({ campaignType: 'awareness' }))
    expect(k.derived.result?.metric).toBeNull()
    expect(k.derived.costPerResult).toBeNull()
  })

  it('messaging campaign: ₹500 for 10 conversations = ₹50 each', () => {
    const k = buildKPIData([row('2026-10-01', { spend: 500, clicks: 80, messages: 10 })], [], project({ campaignType: 'messages' }))
    expect(k.derived.result?.metric).toBe('messages')
    expect(k.derived.costPerResult).toBe(50)
  })

  it('rows synced before conversations were imported are "not recorded", not zero', () => {
    const k = buildKPIData([row('2026-10-01', { spend: 500, clicks: 80 })], [], project({ campaignType: 'messages' }))
    expect(k.derived.results).toBeNull()
    expect(k.derived.costPerResult).toBeNull()
    expect(k.derived.resultCoverage).toEqual({ recordedDays: 0, days: 1 })
  })

  it('partial coverage is reported', () => {
    const k = buildKPIData([
      row('2026-10-01', { spend: 100 }),
      row('2026-10-02', { spend: 100, purchases: 2 }),
    ], [], project({ campaignType: 'sales' }))
    expect(k.derived.results).toBe(2)
    expect(k.derived.resultCoverage).toEqual({ recordedDays: 1, days: 2 })
  })

  it('ratio of totals, not average of daily ratios', () => {
    const k = buildKPIData([
      row('2026-10-01', { spend: 100, leads: 1 }),
      row('2026-10-02', { spend: 300, leads: 9 }),
    ], [], project())
    expect(k.derived.costPerResult).toBeCloseTo(40, 6) // 400/10, not mean(100, 33.3)
  })

  it('unset objective keeps leads only when there are leads', () => {
    expect(resultDefinitionFor(null, { leads: 3 }).metric).toBe('leads')
    expect(resultDefinitionFor(null, { leads: 0 }).metric).toBeNull()
  })

  it('helpers', () => {
    expect(resultCount(resultDefinitionFor('traffic'), { leads: 1, conversions: 2, clicks: 3 })).toBe(3)
    expect(costPerSelectedResult(100, 0)).toBeNull()
    expect(costPerSelectedResult(100, null)).toBeNull()
  })
})

describe('deltas', () => {
  it('growth from a zero baseline is not comparable, not +100%', () => {
    expect(pctChange(50, 0)).toBeNull()
    expect(pctChange(0, 0)).toBe(0)
    expect(pctChange(150, 100)).toBe(50)
  })
  it('CPL delta is null when either period has no leads', () => {
    const k = buildKPIData(
      [row('2026-10-08', { spend: 100, leads: 0, clicks: 10 })],
      [row('2026-10-01', { spend: 100, leads: 5, clicks: 10 })],
      project(),
    )
    expect(k.deltas?.cplDelta).toBeNull()
    expect(k.deltas?.spendDelta).toBe(0)
  })

  it('reach delta uses unique period reach only', () => {
    const rows = [row('2026-10-08', { spend: 100, reach: 500 })]
    const comp = [row('2026-10-01', { spend: 100, reach: 400 })]
    expect(buildKPIData(rows, comp, project()).deltas?.reachDelta).toBeNull()
    const pr = (value: number) => ({ available: true as const, value, source: 'meta', fetchedAt: '' })
    expect(buildKPIData(rows, comp, project(), { period: pr(300), comparison: pr(200) }).deltas?.reachDelta).toBe(50)
  })
})

describe('balances', () => {
  it('remaining is opening balance minus in-period cost, not all-time allocation', () => {
    // ₹10,000 allocated; ₹2,000 ex-GST spent before the period; ₹1,000 in it.
    const opening = 10_000 - 2_000 * 1.18
    const k = buildKPIData([row('2026-10-08', { spend: 1000 })], [], project({ walletAllocation: 10_000, priorSpend: 2000, openingBalance: opening }))
    expect(k.derived.remainingAllocation).toBeCloseTo(opening - 1000 * 1.18, 6)
    expect(k.derived.budgetUtilisation).toBeCloseTo((3000 * 1.18) / 10_000 * 100, 6)
  })
})
