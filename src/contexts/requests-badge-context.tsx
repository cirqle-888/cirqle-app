'use client'

/**
 * Requests badge — count of requests with new external activity, shown on
 * the sidebar's "Requests" item and the App Launcher's "Requests" tile. This
 * is the ONLY global indicator for the Request Portal (design: no popups/
 * toasts). A context (not a bare hook) so the two surfaces share a single
 * subscription/fetch instead of each firing its own Supabase query.
 * Defensive: silently 0 if the portal tables don't exist yet.
 */
import { createContext, useContext, useCallback, useState, type ReactNode } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVisibleInterval } from '@/lib/hooks/use-visible-interval'
import { usePermissions } from '@/contexts/permission-context'

const Ctx = createContext<number | null>(null)

/** How often to re-check while the tab is actually being looked at. */
const REFRESH_MS = 120_000

export function RequestsBadgeProvider({ children }: { children: ReactNode }) {
  const { can } = usePermissions()
  const canSeeRequests = can('requests.view')
  const [badge, setBadge] = useState(0)

  // EGRESS: this used to key off `usePathname()`, so it re-ran a 500-row,
  // 4-column query on EVERY navigation just to compute a `.length`. Now:
  //   - only two columns come back, and only for rows that actually have
  //     external activity (the null check is pushed into the query), so the
  //     response is a fraction of what it was;
  //   - it refreshes on a timer + on tab focus instead of per navigation, and
  //     pauses entirely while the tab is hidden.
  // The staff-viewed comparison stays client-side because PostgREST cannot
  // filter one column against another — doing it server-side would need a
  // generated column or an RPC.
  const refresh = useCallback(async () => {
    if (!canSeeRequests) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from('task_requests')
        .select('last_external_activity_at, last_staff_viewed_at')
        .not('status', 'in', '("rejected","archived")')
        .not('last_external_activity_at', 'is', null)
        .limit(500)
      if (error || !data) return
      setBadge(data.filter((r: { last_external_activity_at: string | null; last_staff_viewed_at: string | null }) =>
        !r.last_staff_viewed_at || r.last_external_activity_at! > r.last_staff_viewed_at
      ).length)
    } catch { /* table missing pre-migration */ }
  }, [canSeeRequests])

  // Shared helper: initial load on the next tick (which is also what keeps this
  // out of react-hooks/set-state-in-effect), a visible-only interval, and a
  // catch-up refresh when the tab regains focus.
  useVisibleInterval(() => { void refresh() }, REFRESH_MS, canSeeRequests)

  return <Ctx.Provider value={canSeeRequests ? badge : 0}>{children}</Ctx.Provider>
}

export function useRequestsBadge(): number {
  const ctx = useContext(Ctx)
  if (ctx === null) throw new Error('useRequestsBadge must be used inside <RequestsBadgeProvider>')
  return ctx
}
