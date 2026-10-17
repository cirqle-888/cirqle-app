import { describe, it, expect } from 'vitest'
import { newFeedToken, looksLikeFeedToken, feedUrl } from './feed-token'

describe('newFeedToken', () => {
  it('is URL-safe, so it survives a paste into a phone, an email or WhatsApp', () => {
    for (let i = 0; i < 200; i++) {
      const t = newFeedToken()
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(t).not.toContain('+')
      expect(t).not.toContain('/')
      expect(t).not.toContain('=')
      expect(encodeURIComponent(t)).toBe(t)
    }
  })

  it('carries 256 bits — 43 base64url characters, unpadded', () => {
    expect(newFeedToken()).toHaveLength(43)
  })

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => newFeedToken()))
    expect(seen.size).toBe(2000)
  })

  it('is spread across the alphabet, not stuck in one corner', () => {
    // A generator that silently lost its randomness (a constant seed, a
    // zero-filled buffer) would still pass the shape checks above. This
    // would not: 2000 tokens draw on essentially the whole alphabet.
    const chars = new Set([...Array.from({ length: 2000 }, () => newFeedToken()).join('')])
    expect(chars.size).toBeGreaterThan(50)
  })

  it('passes its own shape check', () => {
    expect(looksLikeFeedToken(newFeedToken())).toBe(true)
  })
})

describe('looksLikeFeedToken', () => {
  it('rejects what a scanner sends, before any database round-trip', () => {
    for (const bad of [
      '', 'short', null, undefined, 42, {},
      '../../etc/passwd',
      'a'.repeat(23),            // under the floor
      'a'.repeat(129),           // over the ceiling
      'has spaces in it here!!',
      'tok+en/with=padding==',   // plain base64, not base64url
    ]) {
      expect(looksLikeFeedToken(bad)).toBe(false)
    }
  })

  it('accepts a plausible token without claiming it is real', () => {
    expect(looksLikeFeedToken('a'.repeat(43))).toBe(true)
  })
})

describe('feedUrl', () => {
  const token = 'a'.repeat(43)

  it('hands phones webcal://, which means subscribe rather than download once', () => {
    expect(feedUrl('https://app.cirqle.work', token))
      .toBe(`webcal://app.cirqle.work/api/calendar/posting/${token}`)
  })

  it('still offers https for anyone who wants the raw file', () => {
    expect(feedUrl('https://app.cirqle.work', token, { webcal: false }))
      .toBe(`https://app.cirqle.work/api/calendar/posting/${token}`)
  })

  it('tolerates a trailing slash on the origin', () => {
    expect(feedUrl('https://app.cirqle.work/', token))
      .toBe(`webcal://app.cirqle.work/api/calendar/posting/${token}`)
  })

  it('converts a local http origin too, so the flow is testable off production', () => {
    expect(feedUrl('http://localhost:3000', token))
      .toBe(`webcal://localhost:3000/api/calendar/posting/${token}`)
  })
})
