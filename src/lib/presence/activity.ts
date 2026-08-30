/**
 * "Is this person actually at this device right now?" — answered per platform.
 *
 * Cirqle ships as one web app inside three shells: a browser, the Electron
 * desktop app (macOS + Windows) and the Capacitor native app (iOS, iPadOS,
 * Android). They all run this same code, so presence already appears
 * everywhere — but "are they here?" does NOT mean the same thing in each, and
 * answering it with `document.visibilityState` everywhere gets desktop badly
 * wrong:
 *
 *   BROWSER   A hidden tab means they are looking at something else. Visibility
 *             is the right signal.
 *
 *   DESKTOP   A hidden window means almost nothing — the app is docked, behind
 *             the editor, or on another Space, and the person is right there.
 *             Gating on visibility marked people Away three minutes after they
 *             clicked into another app, which is worse than useless. What
 *             actually answers the question is the OS: how long since any input,
 *             and is the screen locked. That is what Teams and Slack use, and
 *             the desktop shell exposes it over `__CIRQLE_DESKTOP__.presence`.
 *
 *   MOBILE    Backgrounding the app genuinely does mean gone — iOS freezes the
 *             webview. Capacitor's App plugin reports it precisely; visibility
 *             is the fallback when the plugin is absent.
 *
 * Older desktop builds have no presence bridge, so that path degrades to the
 * browser rule rather than assuming anyone is present.
 */

import { isNative, getPlatform, capPlugin } from '@/lib/native'
import { inDesktopShell, desktopPresence, type DesktopActivity } from '@/lib/desktop'
import { DESKTOP_IDLE_AWAY_MS } from './status'

export type PresenceDevice = 'web' | 'desktop' | 'mobile'
export type { DesktopActivity }

/**
 * Which of the three shells is this?
 *
 * Mobile is detected through `window.Capacitor` (lib/native.ts) — the native
 * app loads the live web app remotely, so this is the only marker it has.
 * iPadOS reports 'ios' and is therefore 'mobile', which is right: it is the
 * same app, and it backgrounds the same way.
 */
export function currentDevice(): PresenceDevice {
  if (isNative()) return 'mobile'
  if (inDesktopShell()) return 'desktop'
  return 'web'
}

/** 'ios' | 'android' | 'macos' | 'windows' | 'web' — for display, not logic. */
export function platformLabel(): string {
  if (isNative()) return getPlatform()
  if (inDesktopShell()) {
    const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
    return /Windows/i.test(ua) ? 'windows' : /Mac/i.test(ua) ? 'macos' : 'desktop'
  }
  return 'web'
}

// ── The decision, as a pure function ─────────────────────────────────────────

export interface ActivitySignals {
  device: PresenceDevice
  /** document.visibilityState === 'visible' */
  visible: boolean
  /** Capacitor App state. null when the plugin isn't there to ask. */
  appActive: boolean | null
  /** What the desktop shell reports. null off-desktop or on an older build. */
  desktop: DesktopActivity | null
}

/**
 * Whether to send a heartbeat for this device right now.
 *
 * Returning false does NOT mark anyone away — it just stops saying "still
 * here", and the freshness windows in status.ts take it from there. So the
 * cost of a false negative is bounded (they go Away a few minutes later) and
 * the cost of a false positive is unbounded (they look reachable all night).
 * That asymmetry is why the desktop rule leans on the OS rather than guessing.
 */
export function shouldReportPresent(s: ActivitySignals): boolean {
  if (s.device === 'desktop') {
    // No bridge → an older desktop build. Fall back to the browser rule rather
    // than assuming presence; being conservative is the safe direction.
    if (!s.desktop) return s.visible
    if (s.desktop.locked) return false
    return s.desktop.idleSeconds * 1000 < DESKTOP_IDLE_AWAY_MS
  }

  if (s.device === 'mobile') {
    // The plugin is authoritative when present; iOS freezes a backgrounded
    // webview, so visibility agrees with it anyway in almost every case.
    return s.appActive ?? s.visible
  }

  return s.visible
}

// ── Reading the signals ──────────────────────────────────────────────────────

/** Capacitor App state, kept current by subscribeAppState. */
let appActive: boolean | null = null

interface AppPlugin {
  addListener?: (
    event: 'appStateChange',
    cb: (state: { isActive: boolean }) => void,
  ) => Promise<{ remove?: () => void }> | { remove?: () => void }
}

/**
 * Track foreground/background on the native app. No-op elsewhere, and safe to
 * call when the plugin is missing — `appActive` simply stays null and the
 * visibility fallback answers instead.
 */
export function subscribeAppState(onChange: () => void): () => void {
  if (!isNative()) return () => {}
  const App = capPlugin<AppPlugin>('App')
  if (!App?.addListener) return () => {}

  appActive = true
  let handle: { remove?: () => void } | null = null
  let cancelled = false

  void Promise.resolve(
    App.addListener('appStateChange', ({ isActive }) => {
      appActive = isActive
      onChange()
    }),
  ).then(h => {
    if (cancelled) h?.remove?.()
    else handle = h
  }).catch(() => { /* plugin refused — visibility fallback covers it */ })

  return () => { cancelled = true; handle?.remove?.() }
}

/** Gather every signal this platform can offer, then decide. */
export async function isPresentHere(): Promise<boolean> {
  const device = currentDevice()
  const visible =
    typeof document === 'undefined' || document.visibilityState === 'visible'

  let desktop: DesktopActivity | null = null
  if (device === 'desktop') {
    const bridge = desktopPresence()
    if (bridge?.query) {
      try {
        const raw = await bridge.query()
        const idleSeconds = Number(raw?.idleSeconds)
        desktop = {
          idleSeconds: Number.isFinite(idleSeconds) ? Math.max(0, idleSeconds) : 0,
          locked: raw?.locked === true,
        }
      } catch {
        desktop = null   // treat a broken bridge as no bridge
      }
    }
  }

  return shouldReportPresent({ device, visible, appActive, desktop })
}
