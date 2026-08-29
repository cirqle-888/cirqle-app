import { describe, it, expect } from 'vitest'
import {
  isChecklistRequest, BRAND_ONBOARDING_STEPS,
  REQUEST_KIND_CHECKLIST, REQUEST_KIND_REQUEST,
} from './kind'

describe('isChecklistRequest', () => {
  it('is true only for an explicit checklist kind', () => {
    expect(isChecklistRequest({ kind: REQUEST_KIND_CHECKLIST })).toBe(true)
    expect(isChecklistRequest({ kind: REQUEST_KIND_REQUEST })).toBe(false)
  })

  it('reads an unset kind as a normal request', () => {
    // Every row predates the column. Reading those as checklist items would
    // hide real client work from the client's own portal.
    expect(isChecklistRequest({})).toBe(false)
    expect(isChecklistRequest({ kind: null })).toBe(false)
    expect(isChecklistRequest(null)).toBe(false)
    expect(isChecklistRequest(undefined)).toBe(false)
  })

  it('does not treat an unknown kind as complimentary', () => {
    // A future kind must bill and stay visible until someone decides otherwise.
    expect(isChecklistRequest({ kind: 'something_new' })).toBe(false)
  })
})

describe('BRAND_ONBOARDING_STEPS', () => {
  it('has unique titles, since re-running tops up by title', () => {
    const titles = BRAND_ONBOARDING_STEPS.map(s => s.title.trim().toLowerCase())
    expect(new Set(titles).size).toBe(titles.length)
  })

  it('describes every step — the description is the instruction', () => {
    for (const step of BRAND_ONBOARDING_STEPS) {
      expect(step.title.trim().length).toBeGreaterThan(0)
      expect(step.description.trim().length).toBeGreaterThan(0)
    }
  })

  it('covers the setup that actually blocks publishing', () => {
    const all = BRAND_ONBOARDING_STEPS.map(s => s.title.toLowerCase()).join(' | ')
    expect(all).toContain('facebook')
    expect(all).toContain('instagram')
    expect(all).toContain('meta business')
  })
})
