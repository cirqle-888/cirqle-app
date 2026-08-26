import { describe, it, expect } from 'vitest'
import { buildServiceOptions, PACKAGE_GROUP, AGREED_GROUP } from './service-options'

const SERVICES = [
  { id: 'a', name: 'Social Media Poster' },
  { id: 'b', name: 'Offer Flyer' },
  { id: 'c', name: 'Hoarding Design' },
  { id: 'd', name: 'Logo Design' },
]

describe('buildServiceOptions', () => {
  it('returns a plain ungrouped list when nothing is committed', () => {
    const out = buildServiceOptions(SERVICES)
    expect(out).toHaveLength(4)
    expect(out.every(o => o.group === undefined)).toBe(true)
    // Order is the caller's, untouched — the Combobox still smart-sorts it.
    expect(out.map(o => o.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('treats an empty commitment set the same as none', () => {
    const out = buildServiceOptions(SERVICES, {
      packageServiceIds: new Set(), agreedServiceIds: new Set(),
    })
    expect(out.every(o => o.group === undefined)).toBe(true)
  })

  it('pins package services first, then agreed-rate ones, then the rest', () => {
    const out = buildServiceOptions(SERVICES, {
      packageServiceIds: new Set(['c']),
      agreedServiceIds: new Set(['b']),
    })
    expect(out.map(o => o.id)).toEqual(['c', 'b', 'a', 'd'])
    expect(out[0].group).toBe(PACKAGE_GROUP)
    expect(out[1].group).toBe(AGREED_GROUP)
    expect(out[2].group).toBeUndefined()
    expect(out[3].group).toBeUndefined()
  })

  it('lists a service committed BOTH ways only once, under Package', () => {
    const out = buildServiceOptions(SERVICES, {
      packageServiceIds: new Set(['b']),
      agreedServiceIds: new Set(['b']),
    })
    expect(out.filter(o => o.id === 'b')).toHaveLength(1)
    expect(out.find(o => o.id === 'b')!.group).toBe(PACKAGE_GROUP)
  })

  it('never drops or duplicates a service', () => {
    const out = buildServiceOptions(SERVICES, {
      packageServiceIds: new Set(['a', 'c']),
      agreedServiceIds: new Set(['b', 'c']),
    })
    expect(out).toHaveLength(SERVICES.length)
    expect(new Set(out.map(o => o.id)).size).toBe(SERVICES.length)
  })

  it('preserves the caller order within each section', () => {
    const out = buildServiceOptions(SERVICES, { packageServiceIds: new Set(['a', 'c', 'd']) })
    // a, c, d keep their relative order from SERVICES — not alphabetical.
    expect(out.map(o => o.id)).toEqual(['a', 'c', 'd', 'b'])
  })

  it('ignores committed ids that are not in the service list', () => {
    // A package can name a service the viewer cannot see (service scoping) or
    // one since deleted; it must not invent a row.
    const out = buildServiceOptions(SERVICES, { packageServiceIds: new Set(['zzz']) })
    expect(out).toHaveLength(4)
    expect(out.every(o => o.group === undefined)).toBe(true)
  })

  it('carries a reason on every pinned row', () => {
    const out = buildServiceOptions(SERVICES, {
      packageServiceIds: new Set(['a']), agreedServiceIds: new Set(['b']),
    })
    expect(out.find(o => o.id === 'a')!.sub).toBe('in their package')
    expect(out.find(o => o.id === 'b')!.sub).toBe('agreed rate')
    expect(out.find(o => o.id === 'c')!.sub).toBeUndefined()
  })
})
