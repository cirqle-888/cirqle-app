/**
 * Field Marketing — map data-provider abstraction.
 *
 * The MAP CANVAS is always Leaflet (see place-map.tsx). What differs between
 * "free OSM" and "paid Google" is the DATA layer: geocoding an address,
 * reverse-geocoding a dropped pin, and searching for businesses ("supermarkets
 * near me"). That is the seam this interface draws.
 *
 *   getMapProvider()  → the active provider (Nominatim/OSM today).
 *
 * A GoogleProvider implementing the same GeoProvider interface can be added
 * later and selected here behind an env flag — no call site changes. Nothing
 * else in the module imports a concrete provider.
 */

export interface GeoResult {
  label: string          // human display string
  latitude: number
  longitude: number
  category?: string      // provider's class/type, when available
}

export interface GeoProvider {
  readonly name: string
  /** Free-text → candidate locations (address or place name). */
  geocode(query: string, opts?: { near?: { latitude: number; longitude: number } }): Promise<GeoResult[]>
  /** Coordinates → a display address (for a pin the rep dropped on the map). */
  reverseGeocode(latitude: number, longitude: number): Promise<string | null>
  /**
   * Business search near a point. Optional: OSM's is weak, so the UI treats it
   * as best-effort. A future Google Places provider makes this first-class.
   */
  searchNearby?(query: string, near: { latitude: number; longitude: number }): Promise<GeoResult[]>
}

const NOMINATIM = 'https://nominatim.openstreetmap.org'

/**
 * OpenStreetMap / Nominatim provider — free, no key. Rate-limited to ~1 req/s
 * by OSM policy, so callers MUST debounce. Fails soft (returns []/null) so a
 * throttle or offline never breaks the add-place flow.
 */
class NominatimProvider implements GeoProvider {
  readonly name = 'osm'

  async geocode(query: string, opts?: { near?: { latitude: number; longitude: number } }): Promise<GeoResult[]> {
    const q = query.trim()
    if (q.length < 3) return []
    const params = new URLSearchParams({ format: 'jsonv2', q, limit: '6', addressdetails: '1' })
    // Bias results toward the rep's current area with a viewbox (not a hard bound).
    if (opts?.near) {
      const { latitude: la, longitude: lo } = opts.near
      params.set('viewbox', `${lo - 0.15},${la + 0.15},${lo + 0.15},${la - 0.15}`)
    }
    const rows = await this.#get(`/search?${params.toString()}`)
    if (!Array.isArray(rows)) return []
    return rows
      .map((r: Record<string, unknown>) => ({
        label: String(r.display_name ?? ''),
        latitude: Number(r.lat),
        longitude: Number(r.lon),
        category: typeof r.type === 'string' ? r.type : undefined,
      }))
      .filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && r.label)
  }

  async reverseGeocode(latitude: number, longitude: number): Promise<string | null> {
    const params = new URLSearchParams({
      format: 'jsonv2', lat: String(latitude), lon: String(longitude), zoom: '18', addressdetails: '1',
    })
    const row = await this.#get(`/reverse?${params.toString()}`)
    const name = (row as Record<string, unknown> | null)?.display_name
    return typeof name === 'string' ? name : null
  }

  async searchNearby(query: string, near: { latitude: number; longitude: number }): Promise<GeoResult[]> {
    // OSM has no true "places nearby" API; a viewbox-biased free-text search is
    // the closest free equivalent. Good enough to find a named supermarket.
    return this.geocode(query, { near })
  }

  async #get(path: string): Promise<unknown> {
    try {
      const res = await fetch(`${NOMINATIM}${path}`, {
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null // throttled / offline — fail soft
    }
  }
}

let cached: GeoProvider | null = null

/** The active map data provider. Swap the constructor here to adopt Google. */
export function getMapProvider(): GeoProvider {
  if (!cached) cached = new NominatimProvider()
  return cached
}
