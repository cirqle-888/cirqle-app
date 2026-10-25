import { describe, expect, it } from 'vitest'
import { snapshotFingerprint, snapshotProblem } from './snapshot'
import { issueReportToken, hashReportToken, publicReportView, reportShareAllowed } from './public-view'
import { validBudgetRequest } from '@/lib/advertising/review-validation'
import { malayalamSummary } from './summary-language'
import type { ReportConfig, RenderData } from './types'
const config = { projectId: 'p', clientId: 'c', reportType: 'custom', template: 'daily', dateFrom: '2026-10-01', dateTo: '2026-10-07', formats: ['pdf'] } as ReportConfig
const data = { config, project: { clientName: 'Fixture', campaignName: 'Campaign', margin: 999 }, kpi: { primary: { spend: 500, impressions: 1000 }, derived: { results: 0, costPerResult: null, result: { metric: 'leads', label: 'Leads', costLabel: 'Cost per lead' } } }, ai: { executiveSummary: 'Internal margin: 99%' }, benchmarks: { private: true } } as unknown as RenderData

describe('reviewed report boundaries', () => {
  it('ignores object key order and recipient transport changes', () => {
    expect(snapshotFingerprint({ ...config, recipients: [{ email: 'a@example.test' }] })).toBe(snapshotFingerprint({ ...config, generatedBy: 'user', snapshotId: 'snapshot', allowIncomplete: true }))
  })
  it.each(['clientId', 'dateFrom', 'summaryOverride', 'language'])('invalidates approval when %s changes', key => {
    expect(snapshotFingerprint({ ...config, [key]: 'different' })).not.toBe(snapshotFingerprint(config))
  })
  it('blocks missing days and failed sync instead of producing clean zero claims', () => {
    expect(snapshotProblem({ ...data, dataQuality: { missingCount: 2 } } as RenderData)).toContain('2 reporting days')
    expect(snapshotProblem({ ...data, dataQuality: { lastSyncError: 'expired' } } as RenderData)).toContain('last sync failed')
  })
  it('keeps secrets and internal detail out of shared payloads', () => {
    const publicData = JSON.stringify(publicReportView(data))
    expect(publicData).not.toMatch(/margin|benchmark|recipients|projectId|99%/)
    expect(publicData).toContain('Leads: 0')
  })
  it('only permits a ready approved report with a live token', () => {
    const ready = { status: 'ready', review_status: 'approved' }
    const link = { expires_at: '2026-11-01T00:00:00Z', revoked_at: null }
    const now = Date.parse('2026-10-25T00:00:00Z')
    expect(reportShareAllowed(ready, link, now)).toBe(true)
    expect(reportShareAllowed({ ...ready, review_status: 'superseded' }, link, now)).toBe(false)
    expect(reportShareAllowed(ready, { ...link, revoked_at: '2026-10-24' }, now)).toBe(false)
    expect(reportShareAllowed(ready, link, Date.parse('2026-11-02'))).toBe(false)
  })
  it('issues unpredictable distinct tokens and stores only hashes', () => {
    const a = issueReportToken(), b = issueReportToken()
    expect(a.token).toHaveLength(64); expect(a.token).not.toBe(b.token)
    expect(a.hash).toBe(hashReportToken(a.token)); expect(a.hash).not.toBe(a.token)
  })
  it('Malayalam keeps zero results and unavailable cost distinct', () => {
    const summary = malayalamSummary(data)
    expect(summary).toContain('ലീഡുകൾ: 0'); expect(summary).toContain('മതിയായ വിവരങ്ങളില്ല')
    expect(summary).toContain('₹500')
  })
})
describe('budget request validation', () => {
  it.each([0, -1, NaN, Infinity, 10.001, 1e13])('rejects invalid amount %s', amount => expect(validBudgetRequest(amount, 'INR', 'Extend campaign')).not.toBeNull())
  it('accepts exact two-decimal amounts and rejects currency or missing reason', () => {
    expect(validBudgetRequest(1000.25, 'INR', 'Extend campaign')).toBeNull()
    expect(validBudgetRequest(1000, 'rupees', 'Reason')).not.toBeNull()
    expect(validBudgetRequest(1000, 'INR', '')).not.toBeNull()
  })
})
