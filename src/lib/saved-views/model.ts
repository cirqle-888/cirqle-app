/**
 * Named saved views — "My overdue work", "Awaiting client", "Unpaid this month".
 *
 * Every list screen in Cirqle already keeps its filter/sort/column state in the
 * URL (see the `?status=`/`?date=`/`?h_page=` params the Tasks, Invoices,
 * Cashbook and Quotations clients write). So a saved view needs to store
 * nothing more than a name and that URL — the restore path is `router.push`,
 * and the screens need no new state plumbing at all.
 *
 * STORAGE: `employee_favorites`, under `entity_type = 'saved_view'`. That table
 * is deliberately generic (entity_type / entity_id / href / label / icon_key)
 * and its server actions already resolve the employee from the session, so
 * saved views need **no schema change and no new server code** — which matters
 * because the current pass is explicitly not allowed to touch the production
 * schema. The table's `(employee_id, entity_type, entity_id)` unique
 * constraint also gives us the behaviour we want for free: `entity_id` is
 * derived from (path, name), so saving "Unpaid this month" twice on the same
 * screen overwrites the first one instead of growing a pile of duplicates.
 *
 * ACCESS: a saved view is a stored link, so it outlives the permission that
 * created it. Gating is NOT done here — it is done with `canOpenHref` from
 * nav-sections, the same helper the sidebar, launcher, command palette and
 * dashboard layout guard use, so a view can never render a link the router
 * then refuses. This module only models names and query strings.
 *
 * SHARING: because a view is just a URL, sharing it is copying the link. The
 * recipient's own route gate decides whether it opens — nothing about the
 * saved view carries the sharer's access with it.
 *
 * Pure and dependency-free so it can be tested without a database or a React
 * tree.
 */

/** `employee_favorites.entity_type` for every saved view. */
export const SAVED_VIEW_ENTITY_TYPE = 'saved_view'

/** `employee_favorites.icon_key`; resolved through the existing favourite icon map. */
export const SAVED_VIEW_ICON_KEY = 'SlidersHorizontal'

/** Long enough for "Unpaid this month — Dubai", short enough to render as a chip. */
export const MAX_SAVED_VIEW_NAME = 40

/**
 * Params that describe *where you are*, not *what you are looking at*.
 *
 * These are excluded from a saved view and ignored when deciding which view is
 * active, so that paging through "My overdue work" — or arriving via a record
 * deep-link or a `?new=true` create shortcut — does not silently deselect the
 * view you are plainly still inside.
 */
const TRANSIENT_PARAMS: ReadonlySet<string> = new Set([
  'page', 'h_page', 'new', 'focus', 'tab',
])

/** Separator between path and name-slug inside `entity_id`. */
const SLUG_SEP = '::'

export interface SavedView {
  /** `employee_favorites.id` — the row, for deletion. */
  id: string
  /** Stable identity for (path, name); also `employee_favorites.entity_id`. */
  slug: string
  /** The screen this view belongs to, e.g. `/dashboard/invoices`. */
  path: string
  /** Display name, exactly as the user typed it (normalised). */
  name: string
  /** Full restore target: path + normalised query. */
  href: string
  /** Normalised query string, without the leading `?`. */
  query: string
}

/** The shape saved views read out of the favourites store. */
export interface SavedViewRow {
  id: string
  entityType: string
  entityId: string | null
  href: string
  label: string
}

/**
 * Tidy a user-typed name: collapse whitespace, trim, cap the length.
 * Returns `''` for anything that is only whitespace — callers treat that as
 * "no name given" and refuse to save.
 */
export function normalizeViewName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SAVED_VIEW_NAME)
}

/** Lower-cased, punctuation-free form used for identity and duplicate checks. */
function nameKey(name: string): string {
  return normalizeViewName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Identity of a view. Two saves with the same name on the same screen are the
 * same view — differing only in capitalisation or punctuation still collides,
 * which is what someone re-saving "Unpaid This Month" expects.
 *
 * Returns `''` when the name has no usable characters.
 */
export function savedViewSlug(path: string, name: string): string {
  const key = nameKey(name)
  return key ? `${normalizePath(path)}${SLUG_SEP}${key}` : ''
}

/** Strip a trailing slash (but never reduce the path to empty). */
function normalizePath(path: string): string {
  const base = path.split(/[?#]/)[0]
  return base.length > 1 ? base.replace(/\/+$/, '') : base
}

/**
 * Canonical form of a screen's filter state: transient and empty params
 * dropped, keys sorted.
 *
 * Sorting is what makes "is this view active?" answerable — the clients write
 * their params in whatever order their effects happen to run, so two
 * identical filter sets routinely produce two different query strings.
 */
export function normalizeViewQuery(search: string | URLSearchParams): string {
  const params = typeof search === 'string'
    ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    : new URLSearchParams(search)

  const kept: [string, string][] = []
  for (const [k, v] of params.entries()) {
    if (TRANSIENT_PARAMS.has(k)) continue
    // `all` and `null` are how these screens spell "no filter" — the clients
    // initialise with `searchParams.get('h_status') || 'all'` and write a
    // JSON `null` for a cleared date range. Treating them as absent is what
    // makes an unfiltered screen compare equal to a freshly opened one.
    if (v === '' || v === 'all' || v === 'null') continue
    kept.push([k, v])
  }
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
  return kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
}

/** Restore target for a view: the screen plus its canonical filter state. */
export function buildSavedViewHref(path: string, search: string | URLSearchParams): string {
  const q = normalizeViewQuery(search)
  return q ? `${normalizePath(path)}?${q}` : normalizePath(path)
}

/**
 * Is there anything worth naming? Saving the unfiltered screen produces a view
 * identical to clicking the sidebar link, so the UI offers it only once at
 * least one real filter is set.
 */
export function hasSavableFilters(search: string | URLSearchParams): boolean {
  return normalizeViewQuery(search).length > 0
}

/** Read one favourites row as a saved view, or `null` if it is not one. */
export function parseSavedView(row: SavedViewRow): SavedView | null {
  if (row.entityType !== SAVED_VIEW_ENTITY_TYPE) return null
  if (!row.entityId || !row.entityId.includes(SLUG_SEP)) return null
  const name = normalizeViewName(row.label || '')
  if (!name) return null
  const path = normalizePath(row.entityId.split(SLUG_SEP)[0])
  const query = normalizeViewQuery(row.href.split('?')[1] ?? '')
  return { id: row.id, slug: row.entityId, path, name, href: buildSavedViewHref(path, query), query }
}

/**
 * This screen's saved views, alphabetical.
 *
 * Alphabetical rather than by creation order: the chips sit in a row the user
 * scans by name, and a stable position is worth more than recency when there
 * are only a handful of them.
 */
export function listSavedViews(rows: SavedViewRow[], path: string): SavedView[] {
  const here = normalizePath(path)
  return rows
    .map(parseSavedView)
    .filter((v): v is SavedView => !!v && v.path === here)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Which view the current URL is showing, if any. Compares canonical query
 * strings, so param order and transient params do not matter.
 */
export function activeSavedView(
  views: SavedView[],
  search: string | URLSearchParams,
): SavedView | null {
  const now = normalizeViewQuery(search)
  if (!now) return null
  return views.find(v => v.query === now) ?? null
}
