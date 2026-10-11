/**
 * Coming back to a list where you left it.
 *
 * Opening a record from a long list and pressing Back takes you to the top of
 * that list, every time. On the Tasks table that can be two hundred rows
 * above the one you were reading, and the only way back is to scroll and
 * re-find it — which is exactly the "repeated navigation" the improvement
 * plan asks to measure and remove.
 *
 * Filters already survive the trip on the screens that keep them in the URL
 * (Invoices, Cashbook, Contributions), so the missing half is the scroll
 * position. This is that half: a position remembered per screen AND per filter
 * state, restored once when you return, and forgotten when the list you were
 * looking at is no longer the list you are looking at.
 *
 * ── WHY PER FILTER STATE ──────────────────────────────────────────────────
 *
 * Restoring 1,800px into a list that now shows four rows would scroll to the
 * bottom of nothing. Keying on the full URL — path and query — means a
 * remembered position only ever applies to the list it was taken from.
 *
 * `sessionStorage`, deliberately: a scroll position is worth remembering
 * across a Back press, not across a week. It also means nothing to clean up
 * and nothing stored about what anyone was reading once the tab closes.
 *
 * The pure part is here and tested; the hook is in `use-scroll-restore.ts`.
 */

const PREFIX = 'cirqle:list-scroll:v1'

/** How long a remembered position stays useful. */
export const SCROLL_TTL_MS = 30 * 60 * 1000

/** Below this there is nothing worth restoring — and nothing worth storing. */
export const MIN_SCROLL_PX = 120

export interface StoredScroll {
  /** The full `path?query` the position was taken from. */
  at: string
  top: number
  savedAt: number
}

export function scrollStorageKey(screen: string): string {
  return `${PREFIX}:${screen}`
}

/**
 * Canonical identity of "the list I was looking at".
 *
 * Params that only say *where in the list* you were are dropped, so paging
 * does not invalidate the position, and neither does the `focus` param that a
 * record link adds on its way out.
 */
const POSITION_PARAMS: ReadonlySet<string> = new Set(['page', 'h_page', 'focus', 'new'])

export function listIdentity(path: string, search: string | URLSearchParams): string {
  const params = typeof search === 'string'
    ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    : new URLSearchParams(search)
  const kept: [string, string][] = []
  for (const [k, v] of params.entries()) {
    if (POSITION_PARAMS.has(k) || v === '') continue
    kept.push([k, v])
  }
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
  const q = kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  return q ? `${path}?${q}` : path
}

export function encodeScroll(at: string, top: number, now: number): string {
  const payload: StoredScroll = { at, top: Math.max(0, Math.round(top)), savedAt: now }
  return JSON.stringify(payload)
}

/**
 * Read a stored position back, or `null` if it must not be used.
 *
 * Refuses, in order: unparseable JSON, a position from a different list,
 * anything past the TTL, and anything too small to be worth a jump. Each one
 * is a silent `null` — a bad stored value must never be able to throw inside
 * a list screen's effect.
 */
export function decodeScroll(
  raw: string | null,
  at: string,
  now: number,
): number | null {
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const s = parsed as Partial<StoredScroll>
  if (s.at !== at) return null
  if (typeof s.savedAt !== 'number' || !Number.isFinite(s.savedAt)) return null
  if (now - s.savedAt > SCROLL_TTL_MS) return null
  if (typeof s.top !== 'number' || !Number.isFinite(s.top) || s.top < MIN_SCROLL_PX) return null
  return Math.round(s.top)
}

/** Is this position worth storing at all? */
export function worthStoring(top: number): boolean {
  return Number.isFinite(top) && top >= MIN_SCROLL_PX
}
