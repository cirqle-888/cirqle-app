/**
 * Platform-specific content validation — pure, client-safe, unit-tested.
 *
 * Encodes Meta's publishing constraints (verified against developers.facebook.com,
 * Aug 2026) so the composer refuses content Meta would reject (spec §6):
 *
 * Instagram (Content Publishing API):
 *  - Feed images: JPEG only, ≤8 MB, aspect 4:5 … 1.91:1
 *  - Carousels: 2–10 items
 *  - Reels (all IG video): MP4/MOV, 3 s–15 min, ≤300 MB, aspect ~0.01–10 accepted
 *    (9:16 recommended)
 *  - Stories: image or video ≤60 s; no stickers/links/interactive elements via API
 *  - Caption ≤2,200 chars, ≤30 hashtags, ≤20 @-tags
 *  - NO native scheduling → Cirqle queues and publishes at time
 *  - Rate limit: 100 API-published posts / 24 h per IG account
 * Facebook Pages:
 *  - Feed/photo/video posts; native scheduling exists (10 min–30 days) but
 *    Cirqle uses its own queue for a uniform approval flow
 *  - Reels: 9:16, 3–90 s, min 540×960
 */

export type SocialPlatform = 'facebook_page' | 'instagram'
export type SocialContentType =
  | 'image'
  | 'carousel'
  | 'video'
  | 'reel'
  | 'story_image'
  | 'story_video'
  | 'text'
  | 'link'

export interface MediaDescriptor {
  url: string
  type: 'image' | 'video'
  mime?: string
  size_bytes?: number
  width?: number
  height?: number
  duration_s?: number
  storage_path?: string
}

export interface PostDraftInput {
  platform: SocialPlatform
  contentType: SocialContentType
  caption?: string | null
  hashtags?: string | null
  firstComment?: string | null
  linkUrl?: string | null
  media: MediaDescriptor[]
  scheduledAt?: string | null // ISO
}

export interface ValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

const IG_CAPTION_LIMIT = 2200
const IG_HASHTAG_LIMIT = 30
const IG_IMAGE_MAX_BYTES = 8 * 1024 * 1024
const IG_REEL_MAX_BYTES = 300 * 1024 * 1024
const FB_CAPTION_LIMIT = 63206

export function countHashtags(text: string | null | undefined): number {
  if (!text) return 0
  return (text.match(/#[\p{L}\p{N}_]+/gu) ?? []).length
}

/** Which content types each platform supports through official APIs (spec §8). */
export const PLATFORM_CONTENT_SUPPORT: Record<
  SocialPlatform,
  Partial<Record<SocialContentType, 'supported' | 'limited' | 'not_supported'>>
> = {
  instagram: {
    image: 'supported',
    carousel: 'supported',
    video: 'supported', // published as a Reel — all IG video posts are Reels
    reel: 'supported',
    story_image: 'limited', // no stickers/links/polls via API; publish-now only
    story_video: 'limited',
    text: 'not_supported',
    link: 'not_supported',
  },
  facebook_page: {
    image: 'supported',
    carousel: 'supported', // multi-photo post
    video: 'supported',
    reel: 'supported',
    story_image: 'not_supported', // FB Page Stories have no public publishing API
    story_video: 'not_supported',
    text: 'supported',
    link: 'supported',
  },
}

function aspectRatio(m: MediaDescriptor): number | null {
  if (!m.width || !m.height || m.height === 0) return null
  return m.width / m.height
}

export function validateSocialPost(input: PostDraftInput): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const { platform, contentType, media } = input

  // 1. Platform/type support matrix
  const support = PLATFORM_CONTENT_SUPPORT[platform]?.[contentType]
  if (!support || support === 'not_supported') {
    errors.push(
      platform === 'instagram'
        ? `Instagram does not support "${contentType}" posts through the official API.`
        : `Facebook Pages do not support "${contentType}" posts through the official API.`,
    )
    return { ok: false, errors, warnings }
  }
  if (support === 'limited' && platform === 'instagram') {
    warnings.push(
      'Instagram Stories via API are publish-only: no stickers, links, polls or interactive elements, and insights expire after 24 hours.',
    )
  }

  // 2. Caption limits
  const caption = [input.caption ?? '', input.hashtags ?? ''].filter(Boolean).join('\n\n')
  if (platform === 'instagram') {
    if (caption.length > IG_CAPTION_LIMIT) {
      errors.push(`Instagram captions are limited to ${IG_CAPTION_LIMIT} characters (currently ${caption.length}).`)
    }
    const tags = countHashtags(caption)
    if (tags > IG_HASHTAG_LIMIT) {
      errors.push(`Instagram allows at most ${IG_HASHTAG_LIMIT} hashtags (currently ${tags}).`)
    }
    if (input.firstComment && countHashtags(input.firstComment) > IG_HASHTAG_LIMIT) {
      errors.push(`First comment exceeds ${IG_HASHTAG_LIMIT} hashtags.`)
    }
  } else if (caption.length > FB_CAPTION_LIMIT) {
    errors.push(`Facebook posts are limited to ${FB_CAPTION_LIMIT} characters.`)
  }

  // 3. Media count / kind per content type
  const images = media.filter((m) => m.type === 'image')
  const videos = media.filter((m) => m.type === 'video')

  switch (contentType) {
    case 'image':
      if (media.length !== 1 || images.length !== 1) errors.push('Image posts need exactly one image.')
      break
    case 'carousel':
      if (media.length < 2 || media.length > 10) errors.push('Carousels need 2–10 media items.')
      break
    case 'video':
    case 'reel':
      if (media.length !== 1 || videos.length !== 1) errors.push('Video/Reel posts need exactly one video.')
      break
    case 'story_image':
      if (media.length !== 1 || images.length !== 1) errors.push('Image stories need exactly one image.')
      break
    case 'story_video':
      if (media.length !== 1 || videos.length !== 1) errors.push('Video stories need exactly one video.')
      break
    case 'text':
      if (!input.caption?.trim()) errors.push('Text posts need a message.')
      if (media.length > 0) warnings.push('Media is ignored on text posts.')
      break
    case 'link':
      if (!input.linkUrl?.trim()) errors.push('Link posts need a URL.')
      break
  }

  // 4. Per-file constraints (Instagram is the strict one)
  if (platform === 'instagram') {
    for (const m of media) {
      if (m.type === 'image') {
        if (m.mime && !/jpe?g/i.test(m.mime)) {
          errors.push('Instagram accepts JPEG images only — convert PNG/WebP before uploading.')
        }
        if (m.size_bytes && m.size_bytes > IG_IMAGE_MAX_BYTES) {
          errors.push('Instagram images must be ≤8 MB.')
        }
        const ar = aspectRatio(m)
        if (ar !== null && contentType !== 'story_image' && (ar < 0.8 - 0.01 || ar > 1.91 + 0.01)) {
          errors.push(`Instagram feed images must be between 4:5 and 1.91:1 aspect ratio (got ${ar.toFixed(2)}).`)
        }
      } else {
        if (m.size_bytes && m.size_bytes > IG_REEL_MAX_BYTES) {
          errors.push('Instagram videos must be ≤300 MB.')
        }
        if (m.duration_s !== undefined) {
          if (contentType === 'story_video' && m.duration_s > 60) {
            errors.push('Instagram story videos must be ≤60 seconds.')
          }
          if ((contentType === 'video' || contentType === 'reel') && (m.duration_s < 3 || m.duration_s > 15 * 60)) {
            errors.push('Instagram Reels must be between 3 seconds and 15 minutes.')
          }
        }
        if (m.mime && !/(mp4|quicktime|mov)/i.test(m.mime)) {
          errors.push('Instagram videos must be MP4 or MOV.')
        }
      }
    }
  } else {
    // Facebook Reels constraints
    if (contentType === 'reel') {
      const v = videos[0]
      if (v?.duration_s !== undefined && (v.duration_s < 3 || v.duration_s > 90)) {
        errors.push('Facebook Reels must be between 3 and 90 seconds.')
      }
      const ar = v ? aspectRatio(v) : null
      if (ar !== null && Math.abs(ar - 9 / 16) > 0.05) {
        errors.push('Facebook Reels must be 9:16 (portrait).')
      }
    }
  }

  // 5. Scheduling sanity
  if (input.scheduledAt) {
    const when = new Date(input.scheduledAt).getTime()
    if (Number.isNaN(when)) errors.push('Invalid scheduled time.')
    else {
      if (when < Date.now() + 5 * 60 * 1000) {
        errors.push('Schedule at least 5 minutes in the future (or use Publish now).')
      }
      if (when > Date.now() + 75 * 24 * 60 * 60 * 1000) {
        warnings.push('Scheduled more than 75 days ahead — double-check the date.')
      }
      if ((contentType === 'story_image' || contentType === 'story_video') && platform === 'instagram') {
        warnings.push('Story scheduling is handled by Cirqle (Meta has no native story scheduling).')
      }
    }
  }

  // 6. First comment support
  if (input.firstComment && platform !== 'instagram') {
    warnings.push('First comment is only auto-posted on Instagram.')
  }

  return { ok: errors.length === 0, errors, warnings }
}
