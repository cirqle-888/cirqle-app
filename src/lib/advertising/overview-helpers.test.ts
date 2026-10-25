/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
import { describe, it, expect } from 'vitest'
import { periodRange, rowsInPeriod } from './period'
import { objectiveStats } from './objective-stats'
import { buildAttentionItems, withoutSnoozed, type AttentionCampaign } from './attention'
import { aggregateMetrics } from './reporting'
import { resultDefinitionFor } from '@/lib/reporting/result-type'

describe('periodRange', () => {
  it('computes inclusive ranges on the business calendar', () => {
    expect(periodRange('7d', '2026-10-25')).toMatchObject({ from: '2026-10-19', to: '2026-10-25' })
    expect(periodRange('30d', '2026-10-25')).toMatchObject({ from: '2026-09-26', to: '2026-10-25' })
    expect(periodRange('this_month', '2026-10-25')).toMatchObject({ from: '2026-10-01', to: '2026-10-25' })
    expect(periodRange('last_month', '2026-01-10')).toMatchObject({ from: '2025-12-01', to: '2025-12-31' })
    expect(periodRange('last_month', '2028-03-05')).toMatchObject({ from: '2028-02-01', to: '2028-02-29' })
    expect(periodRange('lifetime', '2026-10-25').from).toBeNull()
  })
  it('filters rows', () => {
    const rows = [{ metric_date: '2026-10-18' }, { metric_date: '2026-10-19' }, { metric_date: '2026-10-25' }]
    expect(rowsInPeriod(rows, periodRange('7d', '2026-10-25')).length).toBe(2)
  })
})

describe('objectiveStats', () => {
  const agg = aggregateMetrics([{ metric_date: '2026-10-24', spend: 169.48, impressions: 3233, clicks: 70, leads: 0, messages: 2, revenue: 0 } as any])
  it('leads with conversations and their cost for a messaging campaign', () => {
    const t = objectiveStats(resultDefinitionFor('messages'), agg)
    expect(t.map(x => x.label)).toEqual(['Conversations', 'Cost/conv.', 'Spend', 'CTR'])
    expect(t[0].value).toBe('2')
    expect(t[1].value).toBe('₹84.74')
  })
  it('awareness shows delivery, never ROAS 0', () => {
    const t = objectiveStats(resultDefinitionFor('awareness'), agg)
    expect(t.map(x => x.label)).toEqual(['Impressions', 'CPM', 'Spend', 'CTR'])
  })
  it('ROAS only when revenue is tracked', () => {
    const withRev = aggregateMetrics([{ metric_date: '2026-10-24', spend: 100, revenue: 300, impressions: 10, clicks: 1 } as any])
    expect(objectiveStats(resultDefinitionFor('sales'), withRev)[3]).toEqual({ label: 'ROAS', value: '3.00×' })
  })
})

const camp = (o: Partial<AttentionCampaign> = {}): AttentionCampaign => ({
  id: 'c1', name: 'Sea Star', clientName: 'Sea Star Catering', owner: 'Owner', status: 'active', archived: false,
  syncEnabled: true, syncStatus: 'idle', lastSyncAt: '2026-10-25T00:00:00Z', lastSyncError: null, hasAdAccount: true,
  endDate: null, recentSpendByDate: { '2026-10-24': 50, '2026-10-23': 40 }, unspentAllocation: null, ...o,
})
const base = { today: '2026-10-25', now: new Date('2026-10-25T06:00:00Z'), connections: [], failedReports: [], failedEmails: [] }

describe('buildAttentionItems', () => {
  it('a healthy campaign raises nothing', () => {
    expect(buildAttentionItems({ ...base, campaigns: [camp()] })).toEqual([])
  })
  it('flags overspend, sync errors, staleness and zero spend', () => {
    const items = buildAttentionItems({ ...base, campaigns: [
      camp({ id: 'a', unspentAllocation: -223.42 }),
      camp({ id: 'b', syncStatus: 'error', lastSyncError: 'token invalid' }),
      camp({ id: 'c', lastSyncAt: '2026-10-20T00:00:00Z' }),
      camp({ id: 'd', recentSpendByDate: { '2026-10-24': 0, '2026-10-23': 0 } }),
    ] })
    expect(items.map(i => i.key.split(':')[0])).toEqual(['overspent', 'sync-error', 'sync-stale', 'zero-spend'])
    expect(items[0].reason).toMatch(/₹223 more than allocated/)
  })
  it('flags spending with nothing allocated', () => {
    const items = buildAttentionItems({ ...base, campaigns: [camp({ allocated: 0, spendInclGst: 223.42 })] })
    expect(items.map(i => i.key)).toEqual(['unfunded:c1'])
    expect(items[0].reason).toMatch(/₹223 spent/)
  })
  it('missing days are not "zero spend"', () => {
    expect(buildAttentionItems({ ...base, campaigns: [camp({ recentSpendByDate: { '2026-10-24': 0 } })] })).toEqual([])
  })
  it('connections, ending campaigns and failed reports', () => {
    const items = buildAttentionItems({
      ...base,
      campaigns: [camp({ endDate: '2026-10-27' })],
      connections: [{ id: 'k', name: 'Meta', status: 'active', tokenExpiresAt: '2026-10-28T00:00:00Z' }],
      failedReports: [{ id: 'r1', campaignName: 'X', status: 'failed', createdAt: '2026-10-24', errorMessage: 'pdf failed' }],
    })
    expect(items.map(i => i.key.split(':')[0])).toEqual(['conn-expiry', 'report-failed', 'ending'])
  })
  it('snoozed items stay hidden until the snooze expires', () => {
    const items = buildAttentionItems({ ...base, campaigns: [camp({ unspentAllocation: -1 })] })
    expect(withoutSnoozed(items, { 'overspent:c1': '2026-10-26T00:00:00Z' }, base.now)).toEqual([])
    expect(withoutSnoozed(items, { 'overspent:c1': '2026-10-24T00:00:00Z' }, base.now)).toHaveLength(1)
  })
})
