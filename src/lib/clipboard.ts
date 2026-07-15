/**
 * Copy text to the clipboard, everywhere the app runs.
 *
 * The async Clipboard API is the happy path, but it throws in three situations
 * we actually hit:
 *   • the desktop shell — a WebContentsView that isn't the focused document
 *     rejects `writeText` with NotAllowedError ("Document is not focused"),
 *   • non-secure contexts (plain http://, e.g. a LAN dev host),
 *   • older Android WebViews inside the Capacitor shell.
 *
 * So: try the Electron bridge first when it's there (the main process owns the
 * real OS clipboard and never needs document focus), then the async API, then
 * the execCommand textarea trick. Returns whether the text made it across —
 * callers decide what to toast.
 */
import { desktop } from './desktop'

export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false

  const bridge = desktop()
  if (bridge?.copyText) {
    try {
      if (await bridge.copyText(text)) return true
    } catch { /* fall through */ }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* fall through */ }
  }

  return legacyCopy(text)
}

/** textarea + execCommand('copy') — deprecated, but the only thing left. */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.top = '0'
  el.style.left = '-9999px'
  document.body.appendChild(el)

  const prevSelection = document.getSelection()?.rangeCount
    ? document.getSelection()!.getRangeAt(0)
    : null

  try {
    el.focus()
    el.select()
    el.setSelectionRange(0, el.value.length) // iOS ignores select() on readonly
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    el.remove()
    if (prevSelection) {
      const sel = document.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(prevSelection)
    }
  }
}
