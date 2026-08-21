import { describe, it, expect } from 'vitest'
import {
  distanceMeters, bearingDegrees, compassPoint, formatDistance,
  nearestWithin, isValidLatLng, buildNavigationUrl,
} from './geo'

describe('field/geo', () => {
  // Two points ~150 m apart in central Kochi.
  const a = { latitude: 9.9312, longitude: 76.2673 }
  const b = { latitude: 9.9325, longitude: 76.2673 } // due north

  it('distanceMeters is ~0 for identical points and symmetric', () => {
    expect(distanceMeters(a, a)).toBeCloseTo(0, 5)
    expect(distanceMeters(a, b)).toBeCloseTo(distanceMeters(b, a), 6)
  })

  it('distanceMeters returns a sane metre value', () => {
    const d = distanceMeters(a, b)
    expect(d).toBeGreaterThan(130)
    expect(d).toBeLessThan(160)
  })

  it('bearingDegrees points north for a due-north move', () => {
    const bearing = bearingDegrees(a, b)
    expect(bearing).toBeGreaterThanOrEqual(0)
    expect(bearing).toBeLessThan(2) // ~0° (north), allow float slack
    expect(compassPoint(bearing)).toBe('N')
  })

  it('compassPoint maps the four cardinals', () => {
    expect(compassPoint(0)).toBe('N')
    expect(compassPoint(90)).toBe('E')
    expect(compassPoint(180)).toBe('S')
    expect(compassPoint(270)).toBe('W')
  })

  it('formatDistance switches units at 1 km', () => {
    expect(formatDistance(180)).toBe('180 m')
    expect(formatDistance(2400)).toBe('2.4 km')
    expect(formatDistance(24000)).toBe('24 km')
  })

  it('nearestWithin finds a close place and ignores far ones', () => {
    const places = [
      { id: 'near', latitude: 9.93121, longitude: 76.26731 }, // ~1 m away
      { id: 'far', latitude: 9.95, longitude: 76.3 },
    ]
    const hit = nearestWithin(a, places, 50)
    expect(hit?.place.id).toBe('near')
    expect(nearestWithin(a, [places[1]], 50)).toBeNull()
  })

  it('isValidLatLng rejects out-of-range and null island', () => {
    expect(isValidLatLng(9.93, 76.26)).toBe(true)
    expect(isValidLatLng(0, 0)).toBe(false)
    expect(isValidLatLng(91, 10)).toBe(false)
    expect(isValidLatLng('abc', 10)).toBe(false)
  })

  it('buildNavigationUrl differs per platform', () => {
    expect(buildNavigationUrl(a, { platform: 'ios' })).toContain('maps://')
    const g = buildNavigationUrl(a, { platform: 'other' })
    expect(g).toContain('google.com/maps/dir/')
    expect(g).toContain(`${a.latitude},${a.longitude}`)
  })
})
