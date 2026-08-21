/**
 * Field Marketing — pure geo helpers.
 *
 * No dependencies, no DOM, no Leaflet — so this is unit-testable and safe to
 * import from both server (duplicate check in actions) and client (distance /
 * bearing readout, Navigate button).
 */

export interface LatLng {
  latitude: number
  longitude: number
}

const EARTH_RADIUS_M = 6_371_000

const toRad = (deg: number) => (deg * Math.PI) / 180
const toDeg = (rad: number) => (rad * 180) / Math.PI

/** Great-circle distance between two points, in metres (haversine). */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.latitude - a.latitude)
  const dLng = toRad(b.longitude - a.longitude)
  const lat1 = toRad(a.latitude)
  const lat2 = toRad(b.latitude)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Initial bearing from a → b, in degrees clockwise from north (0–360). */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const lat1 = toRad(a.latitude)
  const lat2 = toRad(b.latitude)
  const dLng = toRad(b.longitude - a.longitude)
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

/** 8-point compass label for a bearing (e.g. 100° → "E"). */
export function compassPoint(bearing: number): (typeof COMPASS)[number] {
  return COMPASS[Math.round(((bearing % 360) / 45)) % 8]
}

/** Human distance: "180 m" under a km, "2.4 km" above. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '—'
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`
}

/**
 * Nearest existing place within `radiusM`, or null. Drives the "you may be
 * about to add a shop that's already on the map" warning so reps don't
 * double-log the same supermarket. Callers pass their own array so this stays
 * pure (server-side dedup or client-side pre-check both use it).
 */
export function nearestWithin<T extends LatLng>(
  point: LatLng,
  places: T[],
  radiusM = 50,
): { place: T; meters: number } | null {
  let best: { place: T; meters: number } | null = null
  for (const p of places) {
    const m = distanceMeters(point, p)
    if (m <= radiusM && (!best || m < best.meters)) best = { place: p, meters: m }
  }
  return best
}

/** True when lat/lng are real, finite, in range — reject the 0,0 null-island too. */
export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  const a = Number(lat)
  const b = Number(lng)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  if (a < -90 || a > 90 || b < -180 || b > 180) return false
  if (a === 0 && b === 0) return false
  return true
}

/**
 * Platform-aware "Navigate" handoff URL. This is the ONE place the app opens an
 * external maps app — only when the rep taps Navigate for turn-by-turn.
 *  - iOS  → Apple Maps (maps://) with driving directions.
 *  - else → Google Maps universal URL (works on Android, desktop, web).
 */
export function buildNavigationUrl(
  dest: LatLng,
  opts: { platform?: 'ios' | 'other'; label?: string } = {},
): string {
  const { latitude, longitude } = dest
  if (opts.platform === 'ios') {
    const q = opts.label ? `&q=${encodeURIComponent(opts.label)}` : ''
    return `maps://?daddr=${latitude},${longitude}&dirflg=d${q}`
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}&travelmode=driving`
}

/** Best-effort platform sniff for the Navigate handoff (browser + Capacitor WebView). */
export function detectPlatform(): 'ios' | 'other' {
  if (typeof navigator === 'undefined') return 'other'
  return /iP(hone|ad|od)/.test(navigator.userAgent) ? 'ios' : 'other'
}

// ── Corridor geometry (§10 "On The Way" — how far a shop sits off a route) ─────
// Local equirectangular projection around `origin`, good for the short offsets
// we care about (metres–kilometres). Returns metres.
function toLocalXY(origin: LatLng, pt: LatLng): [number, number] {
  const R = 6_371_000
  const x = toRad(pt.longitude - origin.longitude) * Math.cos(toRad(origin.latitude)) * R
  const y = toRad(pt.latitude - origin.latitude) * R
  return [x, y]
}

/** Shortest distance (metres) from a point to a polyline path. Infinity if empty. */
export function distanceToPathMeters(p: LatLng, path: LatLng[]): number {
  if (path.length === 0) return Infinity
  if (path.length === 1) return distanceMeters(p, path[0])
  let min = Infinity
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, ay] = toLocalXY(p, path[i])
    const [bx, by] = toLocalXY(p, path[i + 1])
    // p itself is the projection origin → its local coords are (0,0).
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    let t = len2 ? ((-ax) * dx + (-ay) * dy) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    const cx = ax + t * dx, cy = ay + t * dy
    const d = Math.hypot(cx, cy)
    if (d < min) min = d
  }
  return min
}

/** Centroid of a set of points (for locality coverage overlays). Null if empty. */
export function centroid(points: LatLng[]): LatLng | null {
  if (points.length === 0) return null
  const s = points.reduce((a, p) => ({ latitude: a.latitude + p.latitude, longitude: a.longitude + p.longitude }), { latitude: 0, longitude: 0 })
  return { latitude: s.latitude / points.length, longitude: s.longitude / points.length }
}

/** Human duration: "8 min", "1 h 20 min". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}
