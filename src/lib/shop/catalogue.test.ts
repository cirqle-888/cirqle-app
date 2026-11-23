import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS, bannerIsLive, bannerState, cleanBanner, cleanLines, cleanProduct, cleanSettings,
  publicCatalogue, slugify, todayInIndia,
} from './catalogue'

const product = (o: Record<string, unknown> = {}) =>
  cleanProduct({ id: '1', slug: 'polaroid', name: 'Mini polaroid pack', price: 199, pieces: 20, sort: 10, ...o })
const banner = (o: Record<string, unknown> = {}) =>
  cleanBanner({ id: 'b', body: 'Free gift wrap', starts_on: '2026-12-01', ends_on: '2026-12-10', ...o })

describe('shop catalogue', () => {
  it('cleans a gift: bad price becomes 0, unknown audiences are dropped', () => {
    const p = product({ price: 'abc', who: ['her', 'robots'], needs: '20 photos\n\n Captions ' })
    expect(p.price).toBe(0)
    expect(p.who).toEqual(['her'])
    expect(p.needs).toEqual(['20 photos', 'Captions'])
    expect(p.active).toBe(true)
  })

  it('makes a website id from a name', () => {
    expect(slugify('  Retro Wall Polaroids! ')).toBe('retro-wall-polaroids')
  })

  it('reads lines from text or arrays', () => {
    expect(cleanLines(['a', '', 3, 'b'])).toEqual(['a', 'b'])
  })

  it('a banner runs only between its dates and only when on', () => {
    expect(bannerIsLive(banner(), '2026-11-30')).toBe(false)
    expect(bannerIsLive(banner(), '2026-12-01')).toBe(true)
    expect(bannerIsLive(banner(), '2026-12-11')).toBe(false)
    expect(bannerIsLive(banner({ active: false }), '2026-12-05')).toBe(false)
    expect(bannerState(banner(), '2026-11-30')).toBe('scheduled')
    expect(bannerState(banner(), '2026-12-11')).toBe('ended')
  })

  it('a free extra needs a known extra', () => {
    expect(cleanBanner({ body: 'x', free_extra: 'car', free_with: 'polaroid' }).free_with).toBeNull()
  })

  it('settings fall back to the defaults, and a zero delivery charge is kept', () => {
    expect(cleanSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(cleanSettings({ delivery: { kerala: 0, india: 120 } }).delivery).toEqual({ kerala: 0, india: 120 })
  })

  it('the website gets only gifts that are on, and offers only for those gifts', () => {
    const out = publicCatalogue(
      [product(), product({ id: '2', slug: 'lamp', name: 'Lamp', active: false })],
      [banner({ free_extra: 'wrap', free_with: 'lamp' }), banner({ id: 'c', ends_on: '2026-01-01' })],
      cleanSettings({ spotlight: [{ id: 'lamp', title: 'Lamp' }, { id: 'polaroid', title: 'Pack' }] }),
      '2026-11-23',
    )
    expect(out.products.map(p => p.id)).toEqual(['polaroid'])
    expect(out.banners).toHaveLength(1)
    expect(out.banners[0]).not.toHaveProperty('free')
    expect(out.spotlight.map(s => s.id)).toEqual(['polaroid'])
  })

  it('today is the Indian date', () => {
    expect(todayInIndia(new Date('2026-12-01T19:00:00Z'))).toBe('2026-12-02')
  })
})
