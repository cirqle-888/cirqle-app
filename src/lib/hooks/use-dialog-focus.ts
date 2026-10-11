'use client'

/**
 * Keyboard behaviour for a dialog that is NOT built on `ModalOverlay`:
 * trap Tab inside it, and hand focus back to whatever opened it on close.
 *
 * `ModalOverlay` already does both for the modals built on it. The ones that
 * are not — `ConfirmDialog` above all, which some forty call sites share —
 * had neither: Tab walked out of the dialog into the page behind it, and
 * closing one dropped keyboard users at `<body>`, so the next Tab started
 * over from the top of the document.
 *
 * Kept as a hook rather than by rewriting those dialogs onto `ModalOverlay`:
 * the overlay also owns backdrop, z-index, scroll locking and mobile sheet
 * layout, and changing all of that under forty confirmations is a much bigger
 * change than the one that was actually needed. `ModalOverlay` keeps its own
 * copy of this logic for the reason documented there (it reads `onClose`
 * through refs so its effect can run exactly once per open); the two are
 * small and independently correct, and the duplication is the price of not
 * touching a component every screen depends on.
 */
import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  opts: {
    /**
     * A destructive confirmation. Focus goes to the container rather than a
     * control, so a held Enter cannot complete the action, and the initial
     * focus is never the destructive button.
     */
    isConfirmation?: boolean
  } = {},
) {
  const { isConfirmation = false } = opts

  useEffect(() => {
    const node = ref.current
    if (!node) return

    // Remembered before focus moves into the dialog.
    const previouslyFocused = document.activeElement as HTMLElement | null

    const visibleFocusables = () =>
      [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el =>
        // getClientRects catches elements hidden without display:none, which
        // offsetParent misses. The `disabled` PROPERTY check matters too: a
        // button can carry disabled=true as a property while the attribute
        // selector still matches it, and focus() on it silently no-ops —
        // which makes the trap look stuck.
        el.getClientRects().length > 0
        && el.getAttribute('aria-hidden') !== 'true'
        && !(el as HTMLButtonElement).disabled)

    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !node) return
      const focusables = visibleFocusables()
      if (focusables.length === 0) return
      const idx = focusables.indexOf(document.activeElement as HTMLElement)
      if (e.shiftKey && idx <= 0) {
        e.preventDefault()
        focusables[focusables.length - 1].focus()
      } else if (!e.shiftKey && (idx === -1 || idx === focusables.length - 1)) {
        e.preventDefault()
        focusables[0].focus()
      }
    }
    document.addEventListener('keydown', onKey)

    // Deferred: the dialog's own autoFocus (ConfirmDialog's typed-confirmation
    // input has one) should win, and a just-mounted node may not be laid out
    // yet, which would make every focusable invisible to the filter above.
    const t = setTimeout(() => {
      if (node.contains(document.activeElement)) return
      const first = isConfirmation ? null : visibleFocusables()[0]
      if (first) first.focus()
      else node.focus()
    }, 10)

    return () => {
      clearTimeout(t)
      document.removeEventListener('keydown', onKey)
      // Only if it is still in the document — a row's delete button is often
      // unmounted by the very action the dialog confirmed.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus()
      }
    }
    // Intentionally once per mount: a dialog's identity does not change while
    // it is open, and re-running this would re-steal focus on every keystroke
    // in the parent (the bug documented in ModalOverlay).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
