'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { isNative, capPlugin } from '@/lib/native'
import { routeForDeepLink } from '@/lib/deep-link'
import { syncRoute } from '@/lib/mobile/last-route'
import { OfflineIndicator } from '@/components/mobile/offline-indicator'
import { UpdateBanner } from '@/components/mobile/update-banner'

interface StatusBarPlugin {
  setStyle?: (o: { style: 'DARK' | 'LIGHT' }) => Promise<void>
  setOverlaysWebView?: (o: { overlay: boolean }) => Promise<void>
  setBackgroundColor?: (o: { color: string }) => Promise<void>
}
interface SplashScreenPlugin {
  hide?: () => Promise<void>
}

interface PluginListenerHandle { remove: () => Promise<void> }
interface AppPlugin {
  addListener: (
    event: 'backButton' | 'appUrlOpen' | 'appStateChange',
    cb: (data: { canGoBack?: boolean; url?: string; isActive?: boolean }) => void,
  ) => Promise<PluginListenerHandle> | PluginListenerHandle
  exitApp?: () => Promise<void>
}

/**
 * Native shell configuration for the Capacitor app. Renders nothing and does
 * nothing off-native (isNative() gate) — web and Electron are untouched.
 *
 * - StatusBar: non-overlay so the WebView starts below the status bar (Android;
 *   iOS uses contentInset:"always" from capacitor.config, so no overlay there).
 *   Style follows the app theme and re-syncs when the .dark class toggles.
 * - SplashScreen: hidden once the web app has mounted (config keeps it up until
 *   we call hide, avoiding a white flash while the remote URL loads).
 * - Last route: remembered across launches, because Capacitor always boots the
 *   WebView at the site root and keeps no page state of its own. See
 *   @/lib/mobile/last-route.
 *
 * Plugins come from the runtime-injected window.Capacitor.Plugins, so nothing
 * is added to the web bundle. Every call is null-checked and wrapped.
 */
export function MobileShell() {
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (!isNative()) return

    const StatusBar = capPlugin<StatusBarPlugin>('StatusBar')
    const SplashScreen = capPlugin<SplashScreenPlugin>('SplashScreen')

    // Capacitor StatusBar.Style: 'DARK' = light text (for a dark background),
    // 'LIGHT' = dark text (for a light background).
    const isDark = () => document.documentElement.classList.contains('dark')
    const applyStatusBar = () => {
      StatusBar?.setOverlaysWebView?.({ overlay: false }).catch(() => {})
      StatusBar?.setStyle?.({ style: isDark() ? 'DARK' : 'LIGHT' }).catch(() => {})
      StatusBar?.setBackgroundColor?.({ color: isDark() ? '#0b0f1a' : '#ffffff' }).catch(() => {})
    }

    applyStatusBar()
    SplashScreen?.hide?.().catch(() => {})

    // Re-sync the status bar when the theme (.dark class) changes.
    const obs = new MutationObserver(applyStatusBar)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  // Native app lifecycle: Android hardware back button, cirqle:// deep links,
  // and data refresh on resume. Off-native this whole effect no-ops.
  useEffect(() => {
    if (!isNative()) return
    const App = capPlugin<AppPlugin>('App')
    if (!App?.addListener) return

    const handles: PluginListenerHandle[] = []
    const track = (h: Promise<PluginListenerHandle> | PluginListenerHandle) => {
      Promise.resolve(h).then(handle => handles.push(handle)).catch(() => {})
    }

    // Android hardware back: walk WebView history; at the root, exit the app.
    // (Open modals close on their own Escape handler before back reaches root.)
    track(App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack ?? window.history.length > 1) window.history.back()
      else App.exitApp?.().catch(() => {})
    }))

    // cirqle:// deep links opened while the app is running (or cold-started).
    track(App.addListener('appUrlOpen', ({ url }) => {
      const route = url ? routeForDeepLink(url) : null
      if (route) router.push(route)
    }))

    // Revalidate server data when the app returns to the foreground. React
    // client state (open forms, scroll) is preserved by router.refresh().
    track(App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) router.refresh()
    }))

    return () => { handles.forEach(h => { void h.remove().catch(() => {}) }) }
  }, [router])

  // Remember the page across app launches, and restore it on the first mount of
  // a fresh WebView session. Capacitor boots at the site root (which redirects
  // to /dashboard) and saves no page state, so without this every process death
  // or swipe-away relaunch drops the user on the dashboard. Off-native this
  // no-ops entirely — the browser and the desktop app reload in place already.
  //
  // Restore and record are ONE ordered pass (syncRoute) on purpose: the restore
  // has to read storage before the /dashboard landing page overwrites it, which
  // makes it independent of effect declaration order. The once-per-launch flag
  // burns on the first call, so every later navigation just records.
  //
  // A cirqle:// deep link still wins: its appUrlOpen listener fires
  // asynchronously, after this, and pushes over whatever was restored.
  //
  // Two deliberate limits: a query-only change (a filter, a tab) does not move
  // `pathname`, so the stored route is the URL as of the last real navigation;
  // and a launch that lands on /login burns the flag, so signing in by hand
  // takes you to the dashboard rather than back to a page whose permissions may
  // have changed underneath you.
  useEffect(() => {
    if (!isNative()) return
    syncRoute(
      window.location.pathname + window.location.search,
      (to) => router.replace(to),
    )
  }, [pathname, router])

  // Both render null off-native: offline/sync status + native update prompt.
  return (
    <>
      <OfflineIndicator />
      <UpdateBanner />
    </>
  )
}
