/**
 * Field Marketing — road-routing provider abstraction (§18).
 *
 * The map canvas is Leaflet/OSM; ROUTING (road distance, duration, geometry —
 * needed by Plan My Day, Next Best and the On-The-Way detour logic) is a
 * separate concern behind this interface so the provider can be swapped without
 * touching callers.
 *
 *   getRoutingProvider()  → the active provider.
 *
 * Default is OSRM at a CONFIGURABLE base URL (NEXT_PUBLIC_FIELD_ROUTING_URL,
 * default the public OSRM demo). The public demo is fine for light/manual use
 * but is NOT for production traffic volume — point the env at a self-hosted
 * OSRM / GraphHopper / Google Routes for real load. Every call falls back
 * automatically to a straight-line HaversineProvider when routing is
 * unavailable (offline, throttled, over-limit), so the app degrades gracefully
 * and NEVER hard-depends on a paid or rate-limited service.
 *
 * A GraphHopper/Google implementation just implements RoutingProvider and gets
 * selected in getRoutingProvider(); nothing else changes.
 */

import { distanceMeters, type LatLng } from './geo'

export interface RouteResult {
  distanceM: number
  durationS: number
  geometry: LatLng[]     // ordered polyline (for drawing on the map)
  provider: string
  approximate: boolean   // true = straight-line fallback, not a real road route
}

export interface RoutingProvider {
  readonly name: string
  route(waypoints: LatLng[]): Promise<RouteResult>
}

// Urban average when we can only estimate (straight-line fallback): ~18 km/h.
const FALLBACK_SPEED_MPS = 5

function haversineRoute(waypoints: LatLng[]): RouteResult {
  let distanceM = 0
  for (let i = 0; i < waypoints.length - 1; i++) distanceM += distanceMeters(waypoints[i], waypoints[i + 1])
  // Roads are longer than straight lines — pad ~30% so estimates aren't wildly optimistic.
  distanceM *= 1.3
  return { distanceM, durationS: distanceM / FALLBACK_SPEED_MPS, geometry: waypoints, provider: 'straight-line', approximate: true }
}

class OsrmProvider implements RoutingProvider {
  readonly name = 'osrm'
  #base: string
  constructor(base: string) { this.#base = base.replace(/\/$/, '') }

  async route(waypoints: LatLng[]): Promise<RouteResult> {
    if (waypoints.length < 2) return haversineRoute(waypoints)
    const coords = waypoints.map(w => `${w.longitude},${w.latitude}`).join(';')
    try {
      const url = `${this.#base}/route/v1/driving/${coords}?overview=full&geometries=geojson`
      const res = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!res.ok) return haversineRoute(waypoints)
      const json = await res.json()
      const r = json?.routes?.[0]
      if (!r) return haversineRoute(waypoints)
      const geometry: LatLng[] = Array.isArray(r.geometry?.coordinates)
        ? r.geometry.coordinates.map((c: [number, number]) => ({ longitude: c[0], latitude: c[1] }))
        : waypoints
      return { distanceM: Number(r.distance) || 0, durationS: Number(r.duration) || 0, geometry, provider: this.name, approximate: false }
    } catch {
      return haversineRoute(waypoints) // offline / throttled → straight-line
    }
  }
}

const DEFAULT_OSRM = 'https://router.project-osrm.org'
let cached: RoutingProvider | null = null

export function getRoutingProvider(): RoutingProvider {
  if (!cached) {
    const base = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_FIELD_ROUTING_URL) || DEFAULT_OSRM
    cached = new OsrmProvider(base)
  }
  return cached
}

/** Straight-line estimate without any network call (callers that only need a rough number). */
export function estimateStraightRoute(waypoints: LatLng[]): RouteResult {
  return haversineRoute(waypoints)
}
