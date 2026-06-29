import { describe, it, expect } from 'vitest'
import {
  detectPlatform, detectCampaignType, extractBudget, parseAdvertising, buildAdvertisingDraft,
} from './advertising'

describe('detectPlatform', () => {
  it('detects named platforms', () => {
    expect(detectPlatform('run a google ads search campaign')).toBe('google')
    expect(detectPlatform('boost this on instagram')).toBe('instagram')
    expect(detectPlatform('youtube pre-roll')).toBe('youtube')
  })
  it('defaults to meta', () => {
    expect(detectPlatform('run some ads for us')).toBe('meta')
  })
})

describe('detectCampaignType', () => {
  it('maps objective keywords', () => {
    expect(detectCampaignType('lead generation campaign')).toBe('leads')
    expect(detectCampaignType('boost post for engagement')).toBe('engagement')
    expect(detectCampaignType('drive sales from catalog')).toBe('sales')
  })
  it('returns null when nothing matches', () => {
    expect(detectCampaignType('just run something')).toBeNull()
  })
})

describe('extractBudget', () => {
  it('parses currency-marked figures', () => {
    expect(extractBudget('₹20,000 meta budget')).toBe(20000)
    expect(extractBudget('Rs 35000 on google')).toBe(35000)
    expect(extractBudget('INR 20k')).toBe(20000)
  })
  it('parses figures next to the word budget/spend', () => {
    expect(extractBudget('20k budget for ads')).toBe(20000)
    expect(extractBudget('2 lakh spend')).toBe(200000)
  })
  it('returns null when no money figure is present', () => {
    expect(extractBudget('run facebook ads for leads')).toBeNull()
  })
})

describe('parseAdvertising + buildAdvertisingDraft', () => {
  it('produces a draft targeting the new-project form', () => {
    const parsed = parseAdvertising('Run Meta ads ₹20k for lead generation')
    expect(parsed.platform).toBe('meta')
    expect(parsed.campaignType).toBe('leads')
    expect(parsed.adBudget).toBe(20000)

    const draft = buildAdvertisingDraft(parsed, { id: 'c1', name: 'Acme', matchedBy: 'name' })
    expect(draft.type).toBe('advertising')
    expect(draft.target).toBe('/dashboard/requests')
    expect(draft.fields.clientId).toBe('c1')
    expect(draft.fields.platform).toBe('meta')
    expect(draft.fields.campaignType).toBe('leads')
    expect(draft.fields.adBudget).toBe(20000)
  })
  it('falls back to a generated campaign name + null client', () => {
    const parsed = parseAdvertising('google ads')
    const draft = buildAdvertisingDraft(parsed, null)
    expect(draft.fields.clientId).toBeNull()
    expect(String(draft.fields.campaignName).length).toBeGreaterThan(0)
  })
})
