'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { isNative, capPlugin } from '@/lib/native'
import { routeForDeepLink } from '@/lib/deep-link'

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
 *
 * Plugins come from the runtime-injected window.Capacitor.Plugins, so nothing
 * is added to the web bundle. Every call is null-checked and wrapped.
 */
export function MobileShell() {
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

  return null
}
