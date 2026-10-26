import { describe, it, expect } from 'vitest'
import { buildKPIData } from './kpi-engine'
import { resultHeadline, formatResultValue, formatResultCost } from './result-display'
import type { KPIData, ReportMetricRow, ReportProject } from './types'

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

// Sea Star, 24–25 Oct 2026, as Meta reported it.
const seaStar = [
  row('2026-10-24', { spend: 169.48, impressions: 3237, clicks: 72, reach: 2958, messages: 2 }),
  row('2026-10-25', { spend: 186.7, impressions: 3045, clicks: 134, reach: 2458, messages: 8 }),
]

describe('resultHeadline', () => {
  it('a messages campaign reports conversations, not 0 leads', () => {
    const k = buildKPIData(seaStar, [], project({ campaignType: 'messages' }))
    const r = resultHeadline(k, 'messages')
    expect(r.label).toBe('Conversations')
    expect(r.costLabel).toBe('Cost per conversation')
    expect(formatResultValue(r)).toBe('10')
    expect(formatResultCost(r)).toBe('₹35.62')
    expect(r.isLeads).toBe(false)
    expect(r.partial).toBe(false)
  })

  it('a lead campaign keeps leads and cost per lead', () => {
    const k = buildKPIData([row('2026-10-01', { spend: 300, leads: 3 })], [], project({ campaignType: 'leads' }))
    const r = resultHeadline(k, 'leads')
    expect([r.label, r.value, r.cost, r.isLeads]).toEqual(['Leads', 3, 100, true])
  })

  it('an awareness campaign has no result figure and says why', () => {
    const k = buildKPIData([row('2026-10-01', { spend: 300, impressions: 9000 })], [], project({ campaignType: 'awareness' }))
    const r = resultHeadline(k, 'awareness')
    expect(r.value).toBeNull()
    expect(formatResultCost(r)).toBe('—')
    expect(r.reason).toMatch(/reach and CPM/)
  })

  it('never shows a cost when there are no results', () => {
    const k = buildKPIData([row('2026-10-01', { spend: 300, messages: 0 })], [], project({ campaignType: 'messages' }))
    const r = resultHeadline(k, 'messages')
    expect([r.value, r.cost]).toEqual([0, null])
  })

  it('flags conversations recorded on only some days', () => {
    const k = buildKPIData([...seaStar, row('2026-10-26', { spend: 21, messages: null })], [], project({ campaignType: 'messages' }))
    expect(resultHeadline(k, 'messages').partial).toBe(true)
  })

  it('compares the result with the previous period', () => {
    const prev = [row('2026-10-22', { spend: 200, messages: 4 }), row('2026-10-23', { spend: 200, messages: 4 })]
    const k = buildKPIData(seaStar, prev, project({ campaignType: 'messages' }))
    const r = resultHeadline(k, 'messages')
    expect(r.delta).toBe(25)              // 10 vs 8 conversations
    expect(r.costDelta).toBeCloseTo(-28.8, 1) // ₹35.62 vs ₹50.00 each
  })

  it('reads old snapshots without a stored result as leads', () => {
    const k = buildKPIData([row('2026-10-01', { spend: 300, leads: 3 })], [], project({ campaignType: null }))
    const old = { ...k, derived: { ...k.derived, result: undefined, results: undefined } } as KPIData
    const r = resultHeadline(old, null)
    expect([r.label, r.value, r.cost]).toEqual(['Leads', 3, 100])
  })
})
