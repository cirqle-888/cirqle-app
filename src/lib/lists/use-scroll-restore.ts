'use client'

/**
 * `useScrollRestore` — one line per list screen.
 *
 *   useScrollRestore('tasks')
 *
 * Remembers where the list was scrolled to and puts it back when the user
 * returns from a record. The rules — which list a position belongs to, how
 * long it lasts, when it is too small to bother with — are in
 * `scroll-restore.ts` and tested there; this binds them to the DOM.
 *
 * ── WHAT IT SCROLLS ──────────────────────────────────────────────────────
 *
 * The dashboard's `<main id="main-content">` is the scroll container, not the
 * window: the layout gives it `overflow-y-auto` so the sidebar stays put.
 * `window.scrollTo` therefore does nothing here, which is part of why the
 * browser's own scroll restoration never worked on these screens. The window
 * is used as a fallback for any surface rendered outside that layout.
 *
 * Restoring is attempted for a short while rather than once: list screens
 * stream their rows, so the container is often shorter than the saved offset
 * at the moment the effect first runs. The attempts stop as soon as one
 * lands, and give up quietly — a list that genuinely got shorter should not
 * keep being yanked around.
 */
import { useEffect, useRef } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  listIdentity, scrollStorageKey, encodeScroll, decodeScroll, worthStoring,
} from './scroll-restore'

/** How long to keep trying while rows stream in. */
const RESTORE_WINDOW_MS = 1200
const RESTORE_INTERVAL_MS = 100

function container(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.getElementById('main-content')
}

function currentTop(): number {
  const el = container()
  return el ? el.scrollTop : (typeof window === 'undefined' ? 0 : window.scrollY)
}

function scrollTo(top: number) {
  const el = container()
  if (el) el.scrollTop = top
  else if (typeof window !== 'undefined') window.scrollTo(0, top)
}

export function useScrollRestore(screen: string, opts: { enabled?: boolean } = {}) {
  const { enabled = true } = opts
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const identity = listIdentity(pathname, searchParams.toString())

  /** Set once this identity has been restored, so it is not re-applied. */
  const restored = useRef<string | null>(null)

  // ── Put it back ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || restored.current === identity) return
    restored.current = identity

    let raw: string | null = null
    try { raw = sessionStorage.getItem(scrollStorageKey(screen)) } catch { return }
    const top = decodeScroll(raw, identity, Date.now())
    if (top === null) return

    const deadline = Date.now() + RESTORE_WINDOW_MS
    const tick = () => {
      const el = container()
      const limit = el ? el.scrollHeight - el.clientHeight : Number.POSITIVE_INFINITY
      if (limit >= top) { scrollTo(top); return }
      if (Date.now() < deadline) timer = window.setTimeout(tick, RESTORE_INTERVAL_MS)
    }
    let timer = window.setTimeout(tick, 0)
    return () => window.clearTimeout(timer)
  }, [enabled, identity, screen])

  // ── Remember it ───────────────────────────────────────────────────────────
  // Written on the way out rather than on every scroll event: a list being
  // scrolled fires hundreds of those, and the only moment the value matters
  // is the moment the user leaves.
  useEffect(() => {
    if (!enabled) return
    const save = () => {
      const top = currentTop()
      try {
        const key = scrollStorageKey(screen)
        if (worthStoring(top)) sessionStorage.setItem(key, encodeScroll(identity, top, Date.now()))
        else sessionStorage.removeItem(key)
      } catch { /* private mode / quota — the list simply opens at the top */ }
    }
    // A client-side navigation unmounts this without firing pagehide, so save
    // on cleanup too. Both paths are idempotent.
    window.addEventListener('pagehide', save)
    return () => {
      window.removeEventListener('pagehide', save)
      save()
    }
  }, [enabled, identity, screen])
}
