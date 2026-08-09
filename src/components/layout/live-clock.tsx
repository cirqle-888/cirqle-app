'use client'

/**
 * Today's date and a running clock, for the app header.
 *
 * A clock is an external, mutable source, so it uses `useSyncExternalStore`
 * rather than setState-in-an-effect: React renders the server snapshot during
 * hydration and swaps to the live one straight after, which is exactly the
 * behaviour that avoids a hydration mismatch — the server's second and the
 * browser's second are never the same.
 *
 * The snapshot is the MINUTE bucket, not the millisecond. getSnapshot must
 * return a stable value between ticks or React re-renders forever, and the
 * display has no seconds, so the minute is the honest unit.
 *
 * The date shown is the browser's date, which is what the owner means by
 * "today" when comparing it against a calendar on the same screen.
 */

import { useSyncExternalStore } from 'react'

const MINUTE = 60_000

/** Re-renders subscribers on each minute boundary, not every second. */
function subscribe(onChange: () => void): () => void {
  let interval: ReturnType<typeof setInterval> | undefined
  const timeout = setTimeout(() => {
    onChange()
    interval = setInterval(onChange, MINUTE)
  }, MINUTE - (Date.now() % MINUTE))
  return () => { clearTimeout(timeout); if (interval) clearInterval(interval) }
}

const getSnapshot = () => Math.floor(Date.now() / MINUTE)
/** 0 means "not on the client yet" — the placeholder renders instead. */
const getServerSnapshot = () => 0

const DATE_FMT: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }
const TIME_FMT: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: true }

export function LiveClock({ className = '' }: { className?: string }) {
  const minuteBucket = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  // Reserve the width during SSR/hydration so the header does not jump.
  if (!minuteBucket) return <span className={`hidden lg:inline-block w-[104px] ${className}`} aria-hidden />

  const now = new Date(minuteBucket * MINUTE)

  return (
    <span
      className={`hidden lg:flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums whitespace-nowrap ${className}`}
      title={now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
    >
      <span>{now.toLocaleDateString('en-IN', DATE_FMT)}</span>
      <span className="opacity-40">·</span>
      <span className="font-medium text-foreground/80">
        {now.toLocaleTimeString('en-IN', TIME_FMT)}
      </span>
    </span>
  )
}
