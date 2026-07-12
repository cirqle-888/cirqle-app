/**
 * Native capability layer for the Cirqle Capacitor shell.
 *
 * Every function here works on ALL platforms: on native (iOS/Android inside
 * the Capacitor shell) it drives the runtime-injected plugin via capPlugin();
 * on web and Electron it falls back to a standard Web API or degrades to a
 * safe no-op. Nothing here adds a build-time `@capacitor/*` dependency, so the
 * web/desktop bundle is unchanged — the plugins are only present at runtime
 * inside the native app (installed in mobile/package.json + `cap sync`).
 *
 * Design rules:
 * - SSR-safe: all browser/plugin access is lazy and guarded.
 * - Never throw: callers get a boolean/typed result or a graceful fallback.
 * - Additive: existing web/desktop features keep their current code paths;
 *   these helpers are opt-in and only change behavior when isNative().
 */
import { capPlugin, isNative } from '@/lib/native'

// ── Share ─────────────────────────────────────────────────────────────────────

export interface ShareInput {
  title?: string
  text?: string
  url?: string
  /** Local file URIs (native only); ignored on web. */
  files?: string[]
  /** Sheet title (Android). */
  dialogTitle?: string
}

interface SharePlugin {
  share: (o: ShareInput) => Promise<{ activityType?: string }>
  canShare?: () => Promise<{ value: boolean }>
}

/**
 * Open the native share sheet (native), else the Web Share API, else copy the
 * URL/text to the clipboard as a last resort. Returns true if something handled
 * the share (not necessarily that the user completed it).
 */
export async function shareContent(input: ShareInput): Promise<boolean> {
  if (isNative()) {
    const Share = capPlugin<SharePlugin>('Share')
    if (Share?.share) {
      try { await Share.share(input); return true } catch { return false }
    }
  }
  // Web Share API (mobile browsers, some desktop). Files are dropped on web.
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { share?: (d: ShareData) => Promise<void> }) : null
  if (nav?.share) {
    try {
      await nav.share({ title: input.title, text: input.text, url: input.url })
      return true
    } catch { /* user cancelled or unsupported — fall through */ }
  }
  // Last resort: clipboard.
  const fallbackText = input.url || input.text || ''
  if (fallbackText) return writeClipboard(fallbackText)
  return false
}

// ── Clipboard ─────────────────────────────────────────────────────────────────

interface ClipboardPlugin {
  write: (o: { string?: string; url?: string; image?: string }) => Promise<void>
  read: () => Promise<{ value: string; type: string }>
}

export async function writeClipboard(text: string): Promise<boolean> {
  if (isNative()) {
    const Clipboard = capPlugin<ClipboardPlugin>('Clipboard')
    if (Clipboard?.write) {
      try { await Clipboard.write({ string: text }); return true } catch { /* fall through */ }
    }
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true } catch { /* fall through */ }
  }
  return false
}

export async function readClipboard(): Promise<string | null> {
  if (isNative()) {
    const Clipboard = capPlugin<ClipboardPlugin>('Clipboard')
    if (Clipboard?.read) {
      try { return (await Clipboard.read()).value } catch { /* fall through */ }
    }
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
    try { return await navigator.clipboard.readText() } catch { /* fall through */ }
  }
  return null
}

// ── Haptics ───────────────────────────────────────────────────────────────────

interface HapticsPlugin {
  impact: (o: { style: 'HEAVY' | 'MEDIUM' | 'LIGHT' }) => Promise<void>
  notification: (o: { type: 'SUCCESS' | 'WARNING' | 'ERROR' }) => Promise<void>
  selectionChanged?: () => Promise<void>
}

/** Tactile feedback for a tap/press. No-op off-native (vibrate fallback on web). */
export function hapticImpact(style: 'HEAVY' | 'MEDIUM' | 'LIGHT' = 'LIGHT'): void {
  if (isNative()) {
    const Haptics = capPlugin<HapticsPlugin>('Haptics')
    if (Haptics?.impact) { void Haptics.impact({ style }).catch(() => {}); return }
  }
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate?.(style === 'HEAVY' ? 30 : style === 'MEDIUM' ? 15 : 8)
  }
}

/** Success/warning/error feedback (e.g. after saving). No-op off-native. */
export function hapticNotification(type: 'SUCCESS' | 'WARNING' | 'ERROR' = 'SUCCESS'): void {
  if (!isNative()) return
  const Haptics = capPlugin<HapticsPlugin>('Haptics')
  void Haptics?.notification?.({ type }).catch(() => {})
}

// ── Camera / image picker ─────────────────────────────────────────────────────

interface CameraPlugin {
  getPhoto: (o: {
    quality?: number
    allowEditing?: boolean
    resultType: 'dataUrl' | 'base64' | 'uri'
    source?: 'CAMERA' | 'PHOTOS' | 'PROMPT'
  }) => Promise<{ dataUrl?: string; base64String?: string; webPath?: string; format: string }>
}

/**
 * Capture/pick a photo, resolving to a data URL. Native uses the OS camera/
 * gallery; web falls back to a hidden <input type=file capture>. Returns null
 * if cancelled or unavailable.
 */
export async function capturePhoto(
  source: 'CAMERA' | 'PHOTOS' | 'PROMPT' = 'PROMPT',
): Promise<string | null> {
  if (isNative()) {
    const Camera = capPlugin<CameraPlugin>('Camera')
    if (Camera?.getPhoto) {
      try {
        const photo = await Camera.getPhoto({ quality: 80, resultType: 'dataUrl', source })
        return photo.dataUrl ?? null
      } catch { return null }
    }
  }
  // Web fallback: file input. `capture` hints the camera on mobile browsers.
  if (typeof document === 'undefined') return null
  return new Promise<string | null>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    if (source === 'CAMERA') input.setAttribute('capture', 'environment')
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    }
    // If the dialog is dismissed without picking, there's no reliable event;
    // callers treat a never-resolving picker as "cancelled" by unmounting.
    input.click()
  })
}

// ── Local notifications ───────────────────────────────────────────────────────

interface LocalNotificationsPlugin {
  requestPermissions: () => Promise<{ display: string }>
  schedule: (o: { notifications: Array<Record<string, unknown>> }) => Promise<unknown>
}

/** Ask for local-notification permission (native only). Returns granted. */
export async function requestLocalNotificationPermission(): Promise<boolean> {
  if (!isNative()) return false
  const LN = capPlugin<LocalNotificationsPlugin>('LocalNotifications')
  if (!LN?.requestPermissions) return false
  try { return (await LN.requestPermissions()).display === 'granted' } catch { return false }
}

/** Fire an immediate/scheduled local notification (native only; no-op on web). */
export async function scheduleLocalNotification(opts: {
  title: string
  body: string
  id?: number
  at?: Date
}): Promise<boolean> {
  if (!isNative()) return false
  const LN = capPlugin<LocalNotificationsPlugin>('LocalNotifications')
  if (!LN?.schedule) return false
  try {
    await LN.schedule({
      notifications: [{
        id: opts.id ?? Date.now() % 2147483647,
        title: opts.title,
        body: opts.body,
        schedule: opts.at ? { at: opts.at } : undefined,
      }],
    })
    return true
  } catch { return false }
}

// ── Filesystem (save / share a generated file) ────────────────────────────────

interface FilesystemPlugin {
  writeFile: (o: { path: string; data: string; directory?: string; recursive?: boolean }) => Promise<{ uri: string }>
}

/**
 * Persist a base64 payload to the device (native) and return its file URI so it
 * can be handed to shareContent({ files }). On web, triggers a normal browser
 * download and returns null (the download IS the delivery).
 */
export async function saveBase64File(
  filename: string,
  base64: string,
  mimeType = 'application/octet-stream',
): Promise<string | null> {
  if (isNative()) {
    const Filesystem = capPlugin<FilesystemPlugin>('Filesystem')
    if (Filesystem?.writeFile) {
      try {
        const res = await Filesystem.writeFile({ path: filename, data: base64, directory: 'CACHE', recursive: true })
        return res.uri
      } catch { return null }
    }
  }
  // Web: build a data URL and click a download link.
  if (typeof document !== 'undefined') {
    const a = document.createElement('a')
    a.href = `data:${mimeType};base64,${base64}`
    a.download = filename
    a.click()
  }
  return null
}
