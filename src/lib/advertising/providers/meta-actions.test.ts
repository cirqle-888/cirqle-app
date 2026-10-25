import { describe, it, expect } from 'vitest'
import { parseMetaActions } from './meta-actions'

describe('parseMetaActions', () => {
  it('reads leads, conversations, purchases and landing-page views', () => {
    const r = parseMetaActions([
      { action_type: 'lead', value: '4' },
      { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '12' },
      { action_type: 'landing_page_view', value: '90' },
      { action_type: 'omni_purchase', value: '3' },
    ])
    expect(r).toEqual({ leads: 4, messages: 12, purchases: 3, landingPageViews: 90 })
  })

  it('never sums overlapping purchase views of the same event', () => {
    const r = parseMetaActions([
      { action_type: 'purchase', value: '5' },
      { action_type: 'offsite_conversion.fb_pixel_purchase', value: '5' },
      { action_type: 'omni_purchase', value: '5' },
    ])
    expect(r.purchases).toBe(5)
  })

  it('falls back through purchase variants in order', () => {
    expect(parseMetaActions([{ action_type: 'offsite_conversion.fb_pixel_purchase', value: 2 }]).purchases).toBe(2)
  })

  it('does not add lead sub-types to the lead rollup', () => {
    const r = parseMetaActions([
      { action_type: 'lead', value: '6' },
      { action_type: 'onsite_conversion.lead_grouped', value: '6' },
      { action_type: 'offsite_conversion.fb_pixel_lead', value: '2' },
    ])
    expect(r.leads).toBe(6)
  })

  it('absent types and junk read as 0', () => {
    expect(parseMetaActions(undefined)).toEqual({ leads: 0, messages: 0, purchases: 0, landingPageViews: 0 })
    expect(parseMetaActions([{ action_type: 'lead', value: 'NaN' }, null, {}]).leads).toBe(0)
  })
})
