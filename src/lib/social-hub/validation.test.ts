import { describe, it, expect } from 'vitest'
import { validateSocialPost, countHashtags, type PostDraftInput } from './validation'

const img = (over: Partial<{ mime: string; size_bytes: number; width: number; height: number }> = {}) => ({
  url: 'https://x/i.jpg', type: 'image' as const, mime: 'image/jpeg', size_bytes: 1_000_000, width: 1080, height: 1080, ...over,
})
const vid = (over: Partial<{ mime: string; size_bytes: number; width: number; height: number; duration_s: number }> = {}) => ({
  url: 'https://x/v.mp4', type: 'video' as const, mime: 'video/mp4', size_bytes: 5_000_000, width: 1080, height: 1920, duration_s: 20, ...over,
})

function base(over: Partial<PostDraftInput>): PostDraftInput {
  return { platform: 'instagram', contentType: 'image', media: [img()], ...over }
}

describe('countHashtags', () => {
  it('counts basic + unicode hashtags', () => {
    expect(countHashtags('#one #two')).toBe(2)
    expect(countHashtags('#café #日本語 plain')).toBe(2)
    expect(countHashtags(null)).toBe(0)
  })
})

describe('validateSocialPost — Instagram', () => {
  it('accepts a valid square image', () => {
    expect(validateSocialPost(base({})).ok).toBe(true)
  })
  it('rejects non-JPEG image', () => {
    const r = validateSocialPost(base({ media: [img({ mime: 'image/png' })] }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/JPEG/i)
  })
  it('rejects image over 8MB', () => {
    const r = validateSocialPost(base({ media: [img({ size_bytes: 9_000_000 })] }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/8 ?MB/i)
  })
  it('rejects extreme aspect ratio', () => {
    const r = validateSocialPost(base({ media: [img({ width: 2500, height: 1000 })] })) // 2.5:1
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/aspect/i)
  })
  it('accepts 1080x1350 (4:5)', () => {
    expect(validateSocialPost(base({ media: [img({ width: 1080, height: 1350 })] })).ok).toBe(true)
  })
  it('rejects caption over 2200 chars', () => {
    const r = validateSocialPost(base({ caption: 'x'.repeat(2201) }))
    expect(r.ok).toBe(false)
  })
  it('rejects more than 30 hashtags', () => {
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ')
    const r = validateSocialPost(base({ hashtags: tags }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/hashtag/i)
  })
  it('carousel needs 2–10 items', () => {
    expect(validateSocialPost(base({ contentType: 'carousel', media: [img()] })).ok).toBe(false)
    expect(validateSocialPost(base({ contentType: 'carousel', media: Array.from({ length: 11 }, () => img()) })).ok).toBe(false)
    expect(validateSocialPost(base({ contentType: 'carousel', media: [img(), img(), img()] })).ok).toBe(true)
  })
  it('reel duration bounds', () => {
    expect(validateSocialPost(base({ contentType: 'reel', media: [vid({ duration_s: 2 })] })).ok).toBe(false)
    expect(validateSocialPost(base({ contentType: 'reel', media: [vid({ duration_s: 20 * 60 })] })).ok).toBe(false)
    expect(validateSocialPost(base({ contentType: 'reel', media: [vid({ duration_s: 30 })] })).ok).toBe(true)
  })
  it('story video max 60s', () => {
    expect(validateSocialPost(base({ contentType: 'story_video', media: [vid({ duration_s: 90 })] })).ok).toBe(false)
  })
  it('text type not supported on Instagram', () => {
    const r = validateSocialPost(base({ contentType: 'text', media: [], caption: 'hi' }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/does not support/i)
  })
  it('story returns a limited-support warning', () => {
    const r = validateSocialPost(base({ contentType: 'story_image', media: [img({ width: 1080, height: 1920 })] }))
    expect(r.ok).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/Stories/i)
  })
})

describe('validateSocialPost — Facebook', () => {
  it('rejects story_image (no API)', () => {
    const r = validateSocialPost({ platform: 'facebook_page', contentType: 'story_image', media: [img()] })
    expect(r.ok).toBe(false)
  })
  it('accepts a 9:16 reel of 30s', () => {
    const r = validateSocialPost({ platform: 'facebook_page', contentType: 'reel', media: [vid({ width: 1080, height: 1920, duration_s: 30 })] })
    expect(r.ok).toBe(true)
  })
  it('rejects a 120s reel', () => {
    const r = validateSocialPost({ platform: 'facebook_page', contentType: 'reel', media: [vid({ width: 1080, height: 1920, duration_s: 120 })] })
    expect(r.ok).toBe(false)
  })
  it('rejects a 16:9 reel', () => {
    const r = validateSocialPost({ platform: 'facebook_page', contentType: 'reel', media: [vid({ width: 1920, height: 1080, duration_s: 30 })] })
    expect(r.ok).toBe(false)
  })
  it('warns that first comment is IG-only', () => {
    const r = validateSocialPost({ platform: 'facebook_page', contentType: 'image', media: [img()], firstComment: 'hi' })
    expect(r.warnings.join(' ')).toMatch(/first comment/i)
  })
})

describe('validateSocialPost — scheduling', () => {
  it('rejects a past / <5min schedule', () => {
    const r = validateSocialPost(base({ scheduledAt: new Date(Date.now() + 60_000).toISOString() }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/5 minutes/i)
  })
  it('accepts a schedule 1 hour out', () => {
    const r = validateSocialPost(base({ scheduledAt: new Date(Date.now() + 3600_000).toISOString() }))
    expect(r.ok).toBe(true)
  })
})
