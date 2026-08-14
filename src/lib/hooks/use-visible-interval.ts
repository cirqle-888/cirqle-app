'use client'

import { useEffect, useRef } from 'react'

/**
 * setInterval that only fires while the tab is actually visible, plus a single
 * catch-up run when the tab comes back into focus.
 *
 * EGRESS: the app's background polls (conversation lists, notifications) used
 * to run flat-out in every backgrounded tab, all day, whether or not anyone was
 * looking. With six users and a handful of pinned tabs that is a 24/7 floor of
 * Supabase traffic for data nobody is reading. Realtime subscriptions already
 * cover live updates; these polls are only a reconnect/missed-event safety net,
 * so pausing them while hidden costs nothing and saves the idle burn.
 *
 * @param fn        work to run on each tick (also run once on mount)
 * @param ms        interval, only counted while visible
 * @param enabled   set false to disable entirely (e.g. no permission)
 */
export function useVisibleInterval(fn: () => void, ms: number, enabled = true) {
  // Keep the latest callback without making it an effect dependency (so a new
  // inline closure each render doesn't tear down and rebuild the interval).
  // Written in an effect, not during render — react-hooks/refs.
  const saved = useRef(fn)
  useEffect(() => { saved.current = fn }, [fn])

  useEffect(() => {
    if (!enabled) return
    const visible = () =>
      typeof document === 'undefined' || document.visibilityState === 'visible'

    const tick = () => { if (visible()) saved.current() }

    // Initial load on the next tick, matching the previous setTimeout(..., 0).
    const t0 = setTimeout(tick, 0)
    const id = setInterval(tick, ms)
    const onVisible = () => { if (visible()) saved.current() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearTimeout(t0)
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [ms, enabled])
}
