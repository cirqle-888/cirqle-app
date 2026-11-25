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
import { copyToClipboard } from './clipboard'

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
}

export async function writeClipboard(text: string): Promise<boolean> {
  if (isNative()) {
    const Clipboard = capPlugin<ClipboardPlugin>('Clipboard')
    if (Clipboard?.write) {
      try { await Clipboard.write({ string: text }); return true } catch { /* fall through */ }
    }
  }
  // Desktop bridge → async API → execCommand, same as every other copy button.
  return copyToClipboard(text)
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
