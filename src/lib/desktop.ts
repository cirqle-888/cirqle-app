/**
 * Bridge to the Cirqle Desktop (Electron) shell.
 *
 * The desktop app injects `window.__CIRQLE_DESKTOP__` (see
 * `desktop/src/preload-cirqle.js`). In a plain browser this is undefined, so
 * every helper here degrades gracefully — callers check `isDesktop()` first.
 */

export type ReceiptShareAction = 'copy' | 'paste' | 'download'

export interface CirqleDesktopBridge {
  version: number
  retry?: (pane: string) => void
  updateLogo?: (url: string) => void
  /** Share a PNG data URL to the linked WhatsApp pane. Resolves to { ok, action }. */
  shareReceipt?: (
    dataUrl: string,
    filename: string,
    action: ReceiptShareAction,
  ) => Promise<{ ok: boolean; action?: ReceiptShareAction; reason?: string; path?: string }>
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
