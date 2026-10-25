import { describe, expect, it } from 'vitest'
import { buildShareCaption } from './share-caption'
import type { RenderData } from './types'
const fixture = (derived: object) => ({
  project: { clientName: 'Fixture client', campaignName: 'Fixture campaign' },
  config: { dateFrom: '2026-10-01', dateTo: '2026-10-07' },
  kpi: { primary: { spend: 500, impressions: 1000, clicks: 50, reach: 900 }, derived },
}) as RenderData

describe('manual client caption', () => {
  it('does not convert zero leads into click results or zero cost', () => {
    const text = buildShareCaption(fixture({ result: { metric: 'leads', label: 'Leads', costLabel: 'Cost per lead' }, results: 0, costPerResult: null }))
    expect(text).toContain('Leads: 0'); expect(text).toContain('Cost per lead: Not available')
    expect(text).not.toContain('Leads: 50')
  })
  it('uses the saved conversation count and cost', () => {
    const text = buildShareCaption(fixture({ result: { metric: 'messages', label: 'Conversations', costLabel: 'Cost per conversation' }, results: 10, costPerResult: 50 }))
    expect(text).toContain('Conversations: 10'); expect(text).toContain('Cost per conversation: ₹50')
  })
  it('does not represent a daily reach sum as a unique audience', () => {
    const text = buildShareCaption(fixture({}))
    expect(text).toContain('Impressions: 1,000'); expect(text).not.toContain('Reach:')
  })
  it('qualifies incomplete result coverage', () => {
    const text = buildShareCaption(fixture({ resultCoverage: { days: 7, recordedDays: 2 } }))
    expect(text).toContain('these results are incomplete')
  })
})
