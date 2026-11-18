/**
 * Is the on-screen keyboard open? — for the native app shell.
 *
 * The Android shell resizes the WebView when the keyboard opens (Capacitor's
 * SystemBars plugin pads it by the keyboard's height), so the page simply gets
 * shorter. Nothing tells the page WHY it got shorter, and the mobile bottom nav
 * — `fixed bottom-0` — rides up to sit directly on top of the keyboard, taking
 * 72px out of the little room that is left to type in.
 *
 * This watches the viewport height and sets `data-keyboard="open"` on <html>
 * while the keyboard is up; globals.css hides the bottom nav and releases the
 * space reserved for it.
 */

/** A keyboard is never this short; a browser toolbar sliding away can be. */
export const KEYBOARD_MIN_HEIGHT = 140

/**
 * Pure rule: the viewport is at least a keyboard's height shorter than the
 * tallest it has been at this width, and something that takes typing has focus.
 */
export function isKeyboardOpen(baselineHeight: number, currentHeight: number, editableFocused: boolean): boolean {
  if (!editableFocused) return false
  if (!Number.isFinite(baselineHeight) || !Number.isFinite(currentHeight)) return false
  return baselineHeight - currentHeight >= KEYBOARD_MIN_HEIGHT
}

function editableHasFocus(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  if (el.tagName !== 'INPUT') return false
  // Checkboxes, radios, buttons and the like open no keyboard.
  const type = (el as HTMLInputElement).type
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image'].includes(type)
}

/**
 * Start tracking; returns the function that stops it. Sets and clears
 * `data-keyboard` on <html>. Safe to call on any platform — on a desktop the
 * height never drops by a keyboard's worth while a field has focus.
 */
export function trackKeyboard(): () => void {
  if (typeof window === 'undefined') return () => {}
  const root = document.documentElement
  const vv = window.visualViewport
  const height = () => Math.min(window.innerHeight, vv?.height ?? window.innerHeight)

  // Tallest height seen at the current width. Rotating the phone changes the
  // width, and with it what "full height" means.
  let width = window.innerWidth
  let baseline = height()

  const update = () => {
    if (window.innerWidth !== width) { width = window.innerWidth; baseline = height() }
    const h = height()
    if (h > baseline) baseline = h
    if (isKeyboardOpen(baseline, h, editableHasFocus())) root.dataset.keyboard = 'open'
    else delete root.dataset.keyboard
  }

  window.addEventListener('resize', update)
  vv?.addEventListener('resize', update)
  document.addEventListener('focusin', update)
  document.addEventListener('focusout', update)
  update()

  return () => {
    window.removeEventListener('resize', update)
    vv?.removeEventListener('resize', update)
    document.removeEventListener('focusin', update)
    document.removeEventListener('focusout', update)
    delete root.dataset.keyboard
  }
}
