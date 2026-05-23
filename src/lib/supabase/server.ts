import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
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

export async function fetchAll(query: any) {
  const allData: any[] = []
  const PAGE = 1000
  // Fetch up to 100,000 rows max to prevent infinite loops
  for (let page = 0; page < 100; page++) {
    const { data, error } = await query.range(page * PAGE, (page + 1) * PAGE - 1)
    if (error) {
      console.error('[fetchAll] Error fetching data:', error)
      break
    }
    if (data) allData.push(...data)
    if (!data || data.length < PAGE) break
  }
  
  if (allData.length >= 5000) {
    console.warn(`[PERF WARNING] fetchAll/safeFetchAll fetched a very large dataset: ${allData.length} rows. Consider adding date filters or cursor pagination if this grows further.`)
  }
  return { data: allData }
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
    if (seen.has(row[key])) return true
    seen.add(row[key])
  }
  return false
}
