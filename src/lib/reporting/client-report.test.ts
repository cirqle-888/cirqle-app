/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))
vi.mock('./branding-engine', () => ({ resolveBrandConfig: async () => ({}) }))
vi.mock('@/lib/advertising/period-reach', () => ({ fetchPeriodReach: async () => ({ available: false, reason: 'x' }) }))

import { mergeReportParts } from './data-engine'
import { buildKPIData } from './kpi-engine'
import { parseReportRequest, resolveReportScopeMulti } from './config'
import type { ReportMetricRow, ReportProject, ReportRawData } from './types'

const row = (date: string, o: Partial<ReportMetricRow> = {}): ReportMetricRow => ({
  date, spend: 0, revenue: 0, impressions: 0, clicks: 0, reach: 0, leads: 0, conversions: 0,
  messages: null, purchases: null, landingPageViews: null, exchangeRate: 1, ...o,
})
const project = (id: string, o: Partial<ReportProject> = {}): ReportProject => ({
  id, clientId: 'c1', clientName: 'Sea Star', clientCode: 'SS', campaignName: id, platform: 'meta',
  campaignType: 'messages', status: 'active', adBudget: 1000, adBudgetCurrency: 'INR', serviceChargeType: null,
  serviceChargeValue: 0, taxPercent: 0, budgetInputMode: 'total', dailyBudgetConfigured: null,
  budgetDaysConfigured: null, objective: null, startDate: '2026-10-01', endDate: '2026-10-31',
  walletAllocation: 500, openingBalance: 400, priorSpend: 50, ...o,
} as ReportProject)
const part = (p: ReportProject, metrics: ReportMetricRow[]): ReportRawData =>
  ({ project: p, metrics, comparisonMetrics: [], branding: {} as any })

describe('client report merge', () => {
  it('sums days, money and results across campaigns of one objective', () => {
    const m = mergeReportParts([
      part(project('a'), [row('2026-10-24', { spend: 100, impressions: 1000, reach: 900, messages: 2 })]),
      part(project('b'), [row('2026-10-24', { spend: 50, impressions: 500, reach: 450, messages: null }), row('2026-10-25', { spend: 20, messages: 1 })]),
    ], false)
    expect(m.project.campaignName).toBe('Sea Star — 2 campaigns')
    expect(m.project.campaignType).toBe('messages')
    expect(m.project.walletAllocation).toBe(1000)
    expect(m.project.openingBalance).toBe(800)
    expect(m.metrics).toHaveLength(2)
    expect(m.metrics[0]).toMatchObject({ spend: 150, impressions: 1500, reach: 1350, messages: 2 })
    expect(m.periodReach).toMatchObject({ available: false })
    const k = buildKPIData(m.metrics, [], m.project)
    expect(k.derived.results).toBe(3)
    expect(k.derived.costPerResult).toBeCloseTo(170 / 3, 6)
  })

  it('mixed objectives produce no combined result', () => {
    const m = mergeReportParts([
      part(project('a', { campaignType: 'messages' }), [row('2026-10-24', { spend: 100, messages: 2 })]),
      part(project('b', { campaignType: 'leads' }), [row('2026-10-24', { spend: 50, leads: 4 })]),
    ], false)
    expect(m.project.campaignType).toBe('mixed')
    const k = buildKPIData(m.metrics, [], m.project)
    expect(k.derived.result?.metric).toBeNull()
    expect(k.derived.costPerResult).toBeNull()
  })

  it('refuses campaigns from different clients', () => {
    expect(() => mergeReportParts([
      part(project('a'), []), part(project('b', { clientId: 'c2' }), []),
    ], false)).toThrow(/one client/)
  })
})

describe('client report requests', () => {
  const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222']
  it('parses projectIds with the primary first', () => {
    const r = parseReportRequest({ projectIds: ids, dateFrom: '2026-10-01', dateTo: '2026-10-07' })
    expect(r.ok && r.value.projectId).toBe(ids[0])
    expect(r.ok && r.value.projectIds).toEqual(ids)
  })
  it('one id is a normal single-campaign report', () => {
    const r = parseReportRequest({ projectIds: [ids[0]], dateFrom: '2026-10-01', dateTo: '2026-10-07' })
    expect(r.ok && r.value.projectIds).toBeUndefined()
  })
  it('rejects junk ids', () => {
    expect(parseReportRequest({ projectIds: ['x'], dateFrom: '2026-10-01', dateTo: '2026-10-07' }).ok).toBe(false)
  })

  const fake = (rows: any[]) => {
    const q: any = { select: () => q, in: () => q, is: async () => ({ data: rows, error: null }) }
    return { from: () => q }
  }
  it('requires every campaign to belong to the same client', async () => {
    expect((await resolveReportScopeMulti(fake([{ id: ids[0], client_id: 'c1' }, { id: ids[1], client_id: 'c1' }]), ids)).ok).toBe(true)
    expect((await resolveReportScopeMulti(fake([{ id: ids[0], client_id: 'c1' }, { id: ids[1], client_id: 'c2' }]), ids)).ok).toBe(false)
    expect((await resolveReportScopeMulti(fake([{ id: ids[0], client_id: 'c1' }, { id: ids[1], client_id: null }]), ids)).ok).toBe(false)
    expect((await resolveReportScopeMulti(fake([{ id: ids[0], client_id: 'c1' }]), ids)).ok).toBe(false)
  })
})
