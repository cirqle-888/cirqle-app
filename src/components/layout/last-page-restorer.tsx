'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { usePermissions } from '@/contexts/permission-context'
import { safeNextPath } from '@/lib/safe-next-path'

const KEY = 'cirqle-last-page'

/**
 * Reopens an installed app on the page it was left on.
 *
 * The manifest's start_url is fixed, so an installed app (iPhone home screen,
 * Chrome "Install app") that the OS discards in the background used to come
 * back on the dashboard every time. The manifest now launches at
 * `/dashboard?source=pwa`; only that launch is redirected, so choosing
 * "Dashboard" yourself, or reloading a tab, is never overridden.
 *
 * The page is remembered per person: on a shared device someone else's last
 * page is not offered. Renders nothing.
 */
export function LastPageRestorer() {
  const router = useRouter()
  const pathname = usePathname()
  const { user } = usePermissions()
  const who = user.authId
  // An admin previewing someone must not overwrite, or follow, their own page.
  const active = !!who && !user.isViewAs

  // Restore — declared before the save effect so it reads the saved page
  // before anything can replace it.
  useEffect(() => {
    if (!active) return
    if (window.location.pathname !== '/dashboard') return
    if (new URLSearchParams(window.location.search).get('source') !== 'pwa') return

    let target = '/dashboard'
    try {
      const saved = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as { who?: string; path?: string } | null
      const back = saved?.who === who ? safeNextPath(saved.path) : null
      if (back) target = back
    } catch {}
    router.replace(target)
  }, [active, who, router])

  // Save, whenever the page changes and whenever the app is hidden — the
  // moment before the OS may discard it.
  useEffect(() => {
    if (!active) return
    const save = () => {
      const { pathname: p, search } = window.location
      if (search.includes('source=pwa') || search.includes('denied=')) return
      const path = safeNextPath(p + search)
      if (!path) return
      try { window.localStorage.setItem(KEY, JSON.stringify({ who, path })) } catch {}
    }
    save()
    const onHide = () => { if (document.visibilityState === 'hidden') save() }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', save)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', save)
    }
  }, [active, who, pathname])

  return null
}
