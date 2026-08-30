/**
 * Bridge to the Cirqle Desktop (Electron) shell.
 *
 * The desktop app injects `window.__CIRQLE_DESKTOP__` (see
 * `desktop/src/preload-cirqle.js`). In a plain browser this is undefined, so
 * every helper here degrades gracefully — callers check `isDesktop()` first.
 */

export type ReceiptShareAction = 'copy' | 'paste' | 'download'

/** What the desktop shell can tell us about the machine, not the window. */
export interface DesktopActivity {
  /** Seconds since the last keyboard or mouse input, OS-wide. */
  idleSeconds: number
  /** Screen locked, or the machine suspended. */
  locked: boolean
}

export interface CirqleDesktopBridge {
  version: number
  retry?: (pane: string) => void
  updateLogo?: (url: string) => void
  /** Write text to the OS clipboard from the main process (v3+). See lib/clipboard.ts. */
  copyText?: (text: string) => Promise<boolean>

  /**
   * Share a PNG data URL to the linked WhatsApp pane. `caption`, if given, is
   * best-effort typed into WhatsApp's image-caption box (only takes effect
   * for the 'paste' action). Resolves to { ok, action }.
   */
  shareReceipt?: (
    dataUrl: string,
    filename: string,
    action: ReceiptShareAction,
    caption?: string,
  ) => Promise<{ ok: boolean; action?: ReceiptShareAction; reason?: string; path?: string }>

  /** OS idle time + screen lock, for presence (v4+). See lib/presence/activity.ts. */
  presence?: { query: () => Promise<DesktopActivity> }
}

export function desktop(): CirqleDesktopBridge | null {
  if (typeof window === 'undefined') return null
  const d = (window as unknown as { __CIRQLE_DESKTOP__?: CirqleDesktopBridge }).__CIRQLE_DESKTOP__
  return d && typeof d.shareReceipt === 'function' ? d : null
}

/** True when running inside the desktop shell with the receipt-share bridge. */
export function isDesktop(): boolean {
  return desktop() !== null
}

/**
 * True inside the desktop shell of ANY version.
 *
 * Deliberately looser than isDesktop(), which gates on the receipt-share
 * bridge and so answers "can this shell share a receipt?" rather than "is this
 * the desktop app?". Presence needs the second question: an older shell is
 * still the desktop app, it just has fewer capabilities.
 */
export function inDesktopShell(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as unknown as { __CIRQLE_DESKTOP__?: unknown }).__CIRQLE_DESKTOP__
}

/** The presence bridge, or null on the web and on desktop shells before v4. */
export function desktopPresence(): { query: () => Promise<DesktopActivity> } | null {
  if (typeof window === 'undefined') return null
  const d = (window as unknown as { __CIRQLE_DESKTOP__?: CirqleDesktopBridge }).__CIRQLE_DESKTOP__
  return typeof d?.presence?.query === 'function' ? d.presence : null
}

// ── Receipt share preference (persisted in localStorage) ──────────────────────
// `default` is the action chosen in Settings; `always` forces it (no picker
// needed); otherwise the modal falls back to the last action the user picked.
const KEY_DEFAULT = 'cirqle.receiptShare.default'
const KEY_ALWAYS = 'cirqle.receiptShare.always'
const KEY_LAST = 'cirqle.receiptShare.last'

export const RECEIPT_SHARE_LABELS: Record<ReceiptShareAction, string> = {
  copy: 'Copy image + open WhatsApp',
  paste: 'Send to WhatsApp (auto-paste)',
  download: 'Download + reveal in Finder',
}

export const RECEIPT_SHARE_HINTS: Record<ReceiptShareAction, string> = {
  copy: 'Copies the receipt and focuses WhatsApp — press ⌘V in the chat.',
  paste: 'Copies the receipt and pastes it into the currently-open chat.',
  download: 'Saves the receipt to Downloads and opens Finder so you can drag it in.',
}

function read(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function write(key: string, val: string) {
  try { localStorage.setItem(key, val) } catch { /* ignore */ }
}

export function getReceiptSharePref(): { default: ReceiptShareAction; always: boolean } {
  const raw = read(KEY_DEFAULT) as ReceiptShareAction | null
  const def: ReceiptShareAction = raw === 'paste' || raw === 'download' ? raw : 'copy'
  return { default: def, always: read(KEY_ALWAYS) === '1' }
}

export function setReceiptSharePref(next: { default: ReceiptShareAction; always: boolean }) {
  write(KEY_DEFAULT, next.default)
  write(KEY_ALWAYS, next.always ? '1' : '0')
}

/** The action the Share button performs by default: the forced default, else last-used, else the default. */
export function effectiveShareAction(): ReceiptShareAction {
  const pref = getReceiptSharePref()
  if (pref.always) return pref.default
  const last = read(KEY_LAST) as ReceiptShareAction | null
  if (last === 'copy' || last === 'paste' || last === 'download') return last
  return pref.default
}

export function rememberLastShareAction(action: ReceiptShareAction) {
  write(KEY_LAST, action)
}
