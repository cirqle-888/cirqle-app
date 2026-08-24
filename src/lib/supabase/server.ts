import { createServerClient } from '@supabase/ssr'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { Database } from '../../types/supabase'

/**
 * Service-role client that bypasses RLS — use ONLY in server components/routes.
 * Never import or expose this in client-side code.
 */
export function createAdminClient() {
  return createSupabaseClient<any, "public", any>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet: { name: string, value: string, options: any }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {}
        },
      },
    }
  )
}

export function createTypedAdminClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function createTypedServerClient() {
  const cookieStore = await cookies()
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet: { name: string, value: string, options: any }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  )
}

// Tables that returned PGRST205 ("not found in schema cache") at any point
// during this process's lifetime. Subsequent queries against the same table
// short-circuit to an empty result without hitting the network — eliminating
// the per-page-nav wasted round-trip when a migration hasn't been applied.
//
// Cleared on next process restart so once the migration runs and the dev
// server is restarted, the table is queried again.
const MISSING_TABLES = new Set<string>()

// Best-effort table-name extraction from a PostgREST query object. The actual
// table is stored on the query's `url.pathname` (looks like '/rest/v1/<table>')
// but supabase-js doesn't expose this cleanly; we read the internal `_table`
// shape that PostgrestQueryBuilder sets up. Returns null if we can't tell.
function getQueryTable(query: any): string | null {
  // supabase-js stores the table name on the query builder under a few names
  // depending on version — try the most common ones.
  const t = query?.tableName ?? query?._table ?? query?.url?.pathname?.split('/').pop()
  return typeof t === 'string' && t ? t : null
}

export async function fetchAll(query: any): Promise<{ data: any[]; error?: any }> {
  const table = getQueryTable(query)
  if (table && MISSING_TABLES.has(table)) {
    // Skip the round-trip — we already know this table doesn't exist.
    return { data: [] as any[] }
  }

  // Returned alongside the rows so a caller that must not proceed on a partial
  // read can say so. Historically this was logged and dropped, which is fine
  // for a display list and wrong for anything that computes money: a failed
  // page and an empty table were indistinguishable. Callers that ignore the
  // field keep their previous behaviour.
  let failure: any
  const allData: any[] = []
  const PAGE = 1000
  // Fetch up to 100,000 rows max to prevent infinite loops
  for (let page = 0; page < 100; page++) {
    const { data, error } = await query.range(page * PAGE, (page + 1) * PAGE - 1)
    if (error) {
      // PGRST205 = "Could not find the table in the schema cache" — the table
      // doesn't exist in this database (likely an unapplied migration). Cache
      // the absence and short-circuit future calls instead of logging every time.
      if ((error as any).code === 'PGRST205' && table) {
        MISSING_TABLES.add(table)
        if (process.env.NODE_ENV === 'development' && !MISSING_TABLES_LOGGED.has(table)) {
          MISSING_TABLES_LOGGED.add(table)
          console.warn(`[fetchAll] Table "${table}" not found — caching absence; queries for this table will return [] until server restart.`)
        }
      } else {
        console.error('[fetchAll] Error fetching data:', error)
        failure = error
      }
      break
    }
    if (data) allData.push(...data)
    if (!data || data.length < PAGE) break
  }

  if (allData.length >= 5000) {
    console.warn(`[PERF WARNING] fetchAll fetched ${allData.length} rows from "${table ?? 'unknown'}" (${Math.ceil(allData.length / PAGE)} sequential round-trips) — consider adding date filters or cursor pagination.`)
  }

  // Dev-only duplicate detection: catches unstable ordering bugs early
  if (process.env.NODE_ENV === 'development' && hasDuplicateRows(allData)) {
    console.warn('[fetchAll] Duplicate rows detected — ensure query has a stable .order("id") before calling fetchAll.')
  }

  return { data: allData, error: failure }
}

/**
 * The `.in(column, ids)` companion to {@link fetchAll}.
 *
 * A plain `.in()` lookup has TWO independent ceilings, and hitting either one
 * loses rows silently — no error, just a short array:
 *
 *  1. URL length. Every UUID costs ~37 chars in the query string, so a few
 *     hundred ids overflow PostgREST's request line.
 *  2. The 1,000-row response cap. Even a modest id list can match far more
 *     than 1,000 rows — 200 tasks with 6 contributors each is 1,200.
 *
 * Chunking alone fixes (1) and leaves (2); `fetchAll` alone fixes (2) and
 * leaves (1). This does both: the ids are chunked, and every chunk is paged
 * to exhaustion.
 *
 * `makeQuery` must build a FRESH query per call — a PostgREST builder cannot
 * be re-filtered once it has been awaited.
 *
 *   const { data } = await fetchAllIn(
 *     ids => admin.from('contributions').select('task_id, value').in('task_id', ids).order('task_id'),
 *     taskIds,
 *   )
 *
 * Order the query by a stable column: `fetchAll` pages with `.range()`, and an
 * unordered PostgREST result can repeat or skip rows across page boundaries.
 */
export async function fetchAllIn(
  makeQuery: (idChunk: string[]) => any,
  ids: string[],
  chunkSize = 100,
): Promise<{ data: any[]; error?: any }> {
  const unique = Array.from(new Set(ids ?? []))
  if (unique.length === 0) return { data: [] }

  const chunks: string[][] = []
  for (let i = 0; i < unique.length; i += chunkSize) {
    chunks.push(unique.slice(i, i + chunkSize))
  }

  // Chunks run CONCURRENTLY, a few at a time.
  //
  // Serially they were the slowest thing in the reports: department-growth over
  // a 24-month window matches ~1,900 task ids, so contribution_scores alone was
  // 19 round trips one after another — 9.7s for the page against live data.
  //
  // Safe here in a way it is NOT for fetchAll: this takes a FACTORY, so every
  // chunk builds its own query object. fetchAll receives one already-built
  // PostgrestFilterBuilder, which is mutable — calling .range() on it twice
  // before awaiting makes both requests fetch the same page, which silently
  // dropped rows when that was tried. See the comment there.
  const LANES = 4
  const results: { data: any[]; error?: any }[] = new Array(chunks.length)
  let next = 0
  let failure: any

  const lane = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= chunks.length || failure) return
      const res = await fetchAll(makeQuery(chunks[i]))
      results[i] = res
      // Stop at the first failed chunk. Continuing would return a result that
      // looks complete but is missing whole id ranges.
      if (res.error && !failure) failure = res.error
    }
  }
  await Promise.all(Array.from({ length: Math.min(LANES, chunks.length) }, lane))

  // Re-assembled in chunk order, not completion order, so a caller that relies
  // on the id ordering it passed in still gets it.
  const allData: any[] = []
  for (const r of results) {
    if (!r) continue
    if (r.error) break
    allData.push(...(r.data || []))
  }
  return failure ? { data: allData, error: failure } : { data: allData }
}

// Dev-only: log each missing-table once per process so the user knows what's
// happening, instead of either silent (confusing) or repeated (noise).
const MISSING_TABLES_LOGGED = new Set<string>()

/**
 * Run a single (non-paginated) query against a table that may not exist yet
 * (unapplied migration). Skips the network entirely on subsequent calls once
 * absence is known — eliminating the 50-200ms wasted round-trip per page nav.
 *
 * Usage:
 *   safeQuery('task_assignments', supabase.from('task_assignments').select('task_id, employee_id'))
 */
export async function safeQuery<T = any>(
  table: string,
  query: any,
): Promise<{ data: T[]; error: null }> {
  if (MISSING_TABLES.has(table)) return { data: [], error: null }
  const { data, error } = await query
  if (error && (error as any).code === 'PGRST205') {
    MISSING_TABLES.add(table)
    if (process.env.NODE_ENV === 'development' && !MISSING_TABLES_LOGGED.has(table)) {
      MISSING_TABLES_LOGGED.add(table)
      console.warn(`[safeQuery] Table "${table}" not found — caching absence; queries for this table will return [] until server restart.`)
    }
    return { data: [], error: null }
  }
  return { data: (data ?? []) as T[], error: null }
}

// ── Column-existence cache ────────────────────────────────────────────────────
// Mirrors MISSING_TABLES for individual columns. Used by columnExists() so
// a probe query (e.g. "does tasks.deleted_at exist?") only runs once per
// process lifetime, instead of every page load.
const COLUMN_CACHE = new Map<string, Promise<boolean>>()

/**
 * Check whether a column exists on a table, caching the result for the
 * process lifetime. The first call probes via `select(column).limit(0)`;
 * subsequent calls return instantly from cache.
 *
 * Cleared on server restart (so once a migration runs, restart picks it up).
 */
export function columnExists(
  supabase: ReturnType<typeof createAdminClient>,
  table: string,
  column: string,
): Promise<boolean> {
  const key = `${table}.${column}`
  const cached = COLUMN_CACHE.get(key)
  if (cached) return cached

  // Supabase query builders are `PromiseLike`, not real `Promise`. Wrap in
  // `Promise.resolve` so TS lets us cache + return a true Promise.
  const probe = Promise.resolve(
    supabase.from(table).select(column).limit(0)
  ).then(({ error }) => {
    const exists = !error
    if (process.env.NODE_ENV === 'development' && !exists) {
      console.warn(`[columnExists] Column "${key}" not found — caching absence; checks will return false until server restart.`)
    }
    return exists
  })
  COLUMN_CACHE.set(key, probe)
  return probe
}

/**
 * Alias for fetchAll that explicitly communicates intent for safe pagination.
 */
export const safeFetchAll = fetchAll;

/**
 * Enforces stable secondary ordering for paginated queries to prevent row skipping or duplication.
 * Always append this BEFORE calling .range(), .limit(), or safeFetchAll().
 */
export function stablePaginationQuery(query: any) {
  return query.order('id', { ascending: true })
}

/**
 * Utility to detect duplicate rows in a dataset (useful for validating paginated fetches).
 * Returns true if duplicates are found based on the provided key.
 */
export function hasDuplicateRows(data: any[], key: string = 'id'): boolean {
  const seen = new Set()
  for (const row of data) {
    // Rows without the key can't be judged — queries that don't select `id`
    // would otherwise all collide on `undefined` and always report duplicates.
    if (row == null || row[key] === undefined) continue
    if (seen.has(row[key])) return true
    seen.add(row[key])
  }
  return false
}
