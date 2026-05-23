import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

/**
 * Safely fetches all rows for a query by paginating through Supabase's 1000-row limit.
 * WARNING: The query MUST have a stable deterministic sort (e.g., .order('id'))
 * appended before being passed to this function.
 */
export async function safeFetchAll(query: any) {
  const allData: any[] = []
  const PAGE = 1000
  // Fetch up to 100,000 rows max to prevent infinite loops
  for (let page = 0; page < 100; page++) {
    const { data, error } = await query.range(page * PAGE, (page + 1) * PAGE - 1)
    if (error) {
      console.error('safeFetchAll error:', error)
      break
    }
    if (data) allData.push(...data)
    if (!data || data.length < PAGE) break
  }
  
  if (allData.length >= 5000) {
    console.warn(`[PERF WARNING] safeFetchAll fetched a very large dataset: ${allData.length} rows. Consider adding date filters or cursor pagination if this grows further.`)
  }
  return { data: allData }
}
