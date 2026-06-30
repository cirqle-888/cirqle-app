import { describe, it, expect } from 'vitest'
import {
  metaObjectiveToCampaignType, isCampaignType, CIRQLE_CAMPAIGN_TYPES,
} from './campaign-objective'

describe('metaObjectiveToCampaignType', () => {
  it('maps current ODAX objectives', () => {
    expect(metaObjectiveToCampaignType('OUTCOME_LEADS')).toBe('leads')
    expect(metaObjectiveToCampaignType('OUTCOME_ENGAGEMENT')).toBe('engagement')
    expect(metaObjectiveToCampaignType('OUTCOME_TRAFFIC')).toBe('traffic')
    expect(metaObjectiveToCampaignType('OUTCOME_SALES')).toBe('sales')
    expect(metaObjectiveToCampaignType('OUTCOME_AWARENESS')).toBe('awareness')
    expect(metaObjectiveToCampaignType('OUTCOME_APP_PROMOTION')).toBe('app_install')
  })

  it('maps legacy objectives', () => {
    expect(metaObjectiveToCampaignType('LEAD_GENERATION')).toBe('leads')
    expect(metaObjectiveToCampaignType('REACH')).toBe('reach')
    expect(metaObjectiveToCampaignType('LINK_CLICKS')).toBe('traffic')
    expect(metaObjectiveToCampaignType('POST_ENGAGEMENT')).toBe('engagement')
    expect(metaObjectiveToCampaignType('VIDEO_VIEWS')).toBe('video_views')
    expect(metaObjectiveToCampaignType('MESSAGES')).toBe('messages')
    expect(metaObjectiveToCampaignType('CONVERSIONS')).toBe('conversion')
  })

  it('is case- and whitespace-insensitive', () => {
    expect(metaObjectiveToCampaignType('  outcome_leads ')).toBe('leads')
  })

  it('returns null for unknown / empty input', () => {
    expect(metaObjectiveToCampaignType('SOMETHING_NEW')).toBeNull()
    expect(metaObjectiveToCampaignType('')).toBeNull()
    expect(metaObjectiveToCampaignType(null)).toBeNull()
    expect(metaObjectiveToCampaignType(undefined)).toBeNull()
  })
})

describe('isCampaignType', () => {
  it('accepts every value in the dropdown list', () => {
    for (const { value } of CIRQLE_CAMPAIGN_TYPES) {
      expect(isCampaignType(value)).toBe(true)
    }
  })
  it('rejects unknown or empty values', () => {
    expect(isCampaignType('banana')).toBe(false)
    expect(isCampaignType('')).toBe(false)
    expect(isCampaignType(null)).toBe(false)
  })
})
