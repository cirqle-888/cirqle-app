/**
 * Bridge to the Cirqle native mobile shell (Capacitor).
 *
 * The native app loads the live web app remotely (capacitor.config.json
 * `server.url`), so at runtime Capacitor injects `window.Capacitor` into the
 * WebView. Detection therefore needs NO `@capacitor/*` dependency in the web
 * bundle — web and desktop builds stay byte-identical. Specific native plugins
 * (camera, push, biometrics) are dynamic-imported later, guarded by isNative().
 *
 * Mirrors lib/desktop.ts: every helper degrades gracefully off-native, and
 * `typeof window === 'undefined'` guards keep it SSR-safe.
 */

export type NativePlatform = 'ios' | 'android' | 'web'

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
}

function cap(): CapacitorGlobal | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor ?? null
}

/** True only inside the Capacitor native shell (iOS/Android) — never web/desktop. */
export function isNative(): boolean {
  return cap()?.isNativePlatform?.() === true
}

/** 'ios' | 'android' | 'web'. Returns 'web' on the server, in a browser, and in Electron. */
export function getPlatform(): NativePlatform {
  const p = cap()?.getPlatform?.()
  return p === 'ios' || p === 'android' ? p : 'web'
}

export function isIOS(): boolean {
  return getPlatform() === 'ios'
}

export function isAndroid(): boolean {
  return getPlatform() === 'android'
}
