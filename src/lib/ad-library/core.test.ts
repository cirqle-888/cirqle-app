import { describe, expect, it } from 'vitest'
import {
  adsToCsv, cleanIncomingAd, cleanMedia, cleanSavedAd, cleanTags, daysRunning, extFor, mediaPath, ownsPath, parseAdDate,
} from './core'

describe('parseAdDate', () => {
  it('reads the Ad Library date styles', () => {
    expect(parseAdDate('20 Oct 2026')).toBe('2026-10-20')
    expect(parseAdDate('5 Sept 2025')).toBe('2025-09-05')
    expect(parseAdDate('Oct 20, 2026')).toBe('2026-10-20')
    expect(parseAdDate('2026-02-19')).toBe('2026-02-19')
  })
  it('refuses nonsense and impossible days', () => {
    expect(parseAdDate('31 Feb 2026')).toBeNull()
    expect(parseAdDate('yesterday')).toBeNull()
    expect(parseAdDate(42)).toBeNull()
  })
})

describe('daysRunning', () => {
  it('counts both ends', () => {
    expect(daysRunning('2026-11-20', null, '2026-11-23')).toBe(4)
    expect(daysRunning('2026-02-19', '2026-11-17', '2026-11-23')).toBe(272)
    expect(daysRunning(null, null, '2026-11-23')).toBeNull()
  })
})

describe('cleanIncomingAd', () => {
  it('keeps good fields and drops bad links', () => {
    const ad = cleanIncomingAd({
      library_id: '2036375937073787', status: 'active', page_name: '​Amazon India', page_url: 'https://www.facebook.com/AmazonIN/',
      body: 'Shop now', landing_url: 'javascript:alert(1)', started_on: '20 Oct 2026', ended_on: '1 Jan 2020',
      source_url: 'https://evil.example/ads', multiple_versions: true,
    })
    expect(ad).not.toBeNull()
    expect(ad!.page_name).toBe('Amazon India')
    expect(ad!.landing_url).toBeNull()
    expect(ad!.started_on).toBe('2026-10-20')
    expect(ad!.ended_on).toBeNull() // before the start
    expect(ad!.source_url).toBeNull() // not a Facebook page
    expect(ad!.multiple_versions).toBe(true)
  })
  it('needs a numeric Library ID', () => {
    expect(cleanIncomingAd({ library_id: 'abc' })).toBeNull()
    expect(cleanIncomingAd(null)).toBeNull()
  })
})

describe('media paths', () => {
  it('only accepts files in the ad\'s own folder', () => {
    const p = mediaPath('123456789', 0, 'image', extFor('image/jpeg', 'image'))
    expect(p).toBe('fb/123456789/image-0.jpg')
    expect(ownsPath('123456789', p)).toBe(true)
    expect(ownsPath('123456789', 'fb/999999999/image-0.jpg')).toBe(false)
    expect(ownsPath('123456789', 'fb/123456789/../x.jpg')).toBe(false)
    const media = cleanMedia('123456789', [
      { kind: 'video', path: 'fb/123456789/video-1.mp4', poster: 'fb/123456789/poster-1.jpg' },
      { kind: 'image', path: 'other/x.jpg' },
    ])
    expect(media).toEqual([{ kind: 'video', path: 'fb/123456789/video-1.mp4', poster: 'fb/123456789/poster-1.jpg' }])
  })
})

describe('tags and csv', () => {
  it('tidies tags', () => {
    expect(cleanTags('#Offer, video , offer,')).toEqual(['offer', 'video'])
  })
  it('exports a safe CSV', () => {
    const ad = cleanSavedAd({ id: 'x', library_id: '123456789', page_name: '=HYPERLINK("x")', status: 'active', started_on: '2026-11-20', media: [], tags: ['a'], created_at: '2026-11-23T10:00:00Z' })
    const csv = adsToCsv([ad], () => 'Inspiration', () => '', '2026-11-23')
    const line = csv.split('\r\n')[1]
    expect(line).toContain(`"'=HYPERLINK(""x"")"`)
    expect(line).toContain('"4"')
    expect(line).toContain('"Inspiration"')
  })
})
