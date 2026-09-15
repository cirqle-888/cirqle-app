'use server'

/**
 * Telling the server that history moved.
 *
 * WHY THIS EXISTS AS A SERVER ACTION: most task writes in this app happen in
 * the BROWSER — `tasks-client.tsx`, `contributions-client.tsx` and
 * `invoices-client.tsx` call Supabase directly and then `router.refresh()`.
 * `revalidateTag` cannot be called from there; it only exists on the server.
 * Without this door, a back-dated task saved from the tasks page would sit
 * behind a stale aggregate for up to 24 hours.
 *
 * It is deliberately tiny and deliberately harmless: the worst a caller can do
 * is throw away a cache entry, costing one re-read. It still requires a signed-
 * in user, because an unauthenticated endpoint that forces database reads is a
 * free way to run up somebody's egress bill — which is the exact thing this
 * whole cache exists to reduce.
 */

import { loadCurrentUser } from '@/lib/permissions/check'
import { invalidateAnalyticsForDates } from '@/lib/analytics/invalidate'

export async function notifyAnalyticsChanged(
  dates: (string | null | undefined)[],
): Promise<{ busted: string[] }> {
  const user = await loadCurrentUser()
  if (!user) return { busted: [] }
  // Never let a cache bust fail a save the user already completed.
  try {
    return { busted: await invalidateAnalyticsForDates(dates.slice(0, 200)) }
  } catch {
    return { busted: [] }
  }
}

/**
 * Clear every cached month.
 *
 * For a bulk import or a recalculation that spans an unknown set of months —
 * enumerating them would mean re-reading the very rows the cache exists to
 * avoid reading, and an import already costs far more than one rebuild.
 */
export async function notifyAnalyticsBulkChange(): Promise<void> {
  const user = await loadCurrentUser()
  if (!user) return
  const { invalidateAllAnalytics } = await import('@/lib/analytics/invalidate')
  await invalidateAllAnalytics()
}
