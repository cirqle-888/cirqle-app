'use client'

/**
 * Requests badge — count of requests with new external activity, shown on
 * the sidebar's "Requests" item and the App Launcher's "Requests" tile. This
 * is the ONLY global indicator for the Request Portal (design: no popups/
 * toasts). A context (not a bare hook) so the two surfaces share a single
 * subscription/fetch instead of each firing its own Supabase query.
 * Defensive: silently 0 if the portal tables don't exist yet.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/contexts/permission-context'

const Ctx = createContext<number | null>(null)

export function RequestsBadgeProvider({ children }: { children: ReactNode }) {
  const { can } = usePermissions()
  const pathname = usePathname()
  const canSeeRequests = can('requests.view')
  const [badge, setBadge] = useState(0)

  useEffect(() => {
    if (!canSeeRequests) { setBadge(0); return }
    let alive = true
    ;(async () => {
      try {
        const supabase = createClient()
        const { data, error } = await supabase
          .from('task_requests')
          .select('id, last_external_activity_at, last_staff_viewed_at, status')
          .not('status', 'in', '("rejected","archived")')
          .limit(500)
        if (!alive || error || !data) return
        setBadge(data.filter((r: any) =>
          r.last_external_activity_at &&
          (!r.last_staff_viewed_at || r.last_external_activity_at > r.last_staff_viewed_at)
        ).length)
      } catch { /* table missing pre-migration */ }
    })()
    return () => { alive = false }
  }, [canSeeRequests, pathname])

  return <Ctx.Provider value={badge}>{children}</Ctx.Provider>
}

export function useRequestsBadge(): number {
  const ctx = useContext(Ctx)
  if (ctx === null) throw new Error('useRequestsBadge must be used inside <RequestsBadgeProvider>')
  return ctx
}
