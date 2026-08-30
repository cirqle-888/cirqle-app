'use client'

import { useEffect, useId, useRef, useState } from 'react'

interface ModalOverlayProps {
  onClose: () => void
  children: React.ReactNode
  /** Set true for confirmation/warning dialogs — disables outside-click and Escape */
  isConfirmation?: boolean
  /**
   * When true: below the `sm` breakpoint the modal docks to the bottom of the
   * viewport (bottom-sheet pattern). Above `sm` it's a centered dialog as
   * usual. The modal's own child should use responsive rounded corners
   * (e.g. `rounded-t-2xl sm:rounded-2xl`) and `h-full sm:h-auto` to take the
   * pattern advantage.
   */
  sheetOnMobile?: boolean
  className?: string
  zIndex?: string
}

/**
 * Standard modal backdrop.
 * - Click outside the content box → closes (unless isConfirmation)
 * - Press Escape → closes (unless isConfirmation)
 * - Optional `sheetOnMobile` for bottom-sheet behavior on small screens.
 */
export function ModalOverlay({
  onClose, children, isConfirmation = false, sheetOnMobile = false, className = '', zIndex = 'z-50',
}: ModalOverlayProps) {
  const contentRef = useRef<HTMLDivElement>(null)

  // Announce the dialog by its visible title: find the first heading in the
  // content, give it an id if it lacks one, and point aria-labelledby at it.
  // One hook here labels every ModalOverlay consumer without per-modal wiring.
  const fallbackTitleId = useId()
  const [labelledBy, setLabelledBy] = useState<string | undefined>(undefined)
  useEffect(() => {
    const heading = contentRef.current?.querySelector('h1, h2, h3')
    if (heading) {
      if (!heading.id) heading.id = fallbackTitleId
      setLabelledBy(heading.id)
    }
  }, [fallbackTitleId])

  // onClose/isConfirmation are read through refs inside the mount effect below
  // so that effect can have an EMPTY dependency array and run exactly once per
  // modal open. Almost every caller passes an inline `onClose={() => ...}`, a
  // fresh function reference on every parent render — with onClose in the
  // deps array, typing into any field (setState → parent re-render → new
  // onClose) tore the effect down and rebuilt it on every keystroke: teardown
  // refocused whatever opened the modal, then setup refocused the "first
  // focusable" element, which is usually the header's close (X) button — so
  // focus visibly jumped to the X after every character typed.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const isConfirmationRef = useRef(isConfirmation)
  isConfirmationRef.current = isConfirmation

  useEffect(() => {
    // Lock body scroll when mounted
    const originalStyle = window.getComputedStyle(document.body).overflow
    document.body.style.overflow = 'hidden'

    // Remember what had focus so it can be handed back when the dialog closes
    // — without this, closing a modal dropped keyboard users at <body>.
    const previouslyFocused = document.activeElement as HTMLElement | null

    const FOCUSABLE =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isConfirmationRef.current) onCloseRef.current()

      // Focus trap: keep Tab / Shift+Tab cycling inside the dialog. Applies to
      // confirmations too — Escape is what's deliberately disabled there.
      if (e.key === 'Tab' && contentRef.current) {
        // getClientRects catches elements hidden without display:none, which
        // offsetParent misses. The (el as any).disabled property check matters
        // too: a button can carry disabled=true as a DOM property while the
        // attribute selector :not([disabled]) still matches — focus() on it
        // silently no-ops and the trap would appear stuck.
        const focusables = [...contentRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
          .filter(el =>
            el.getClientRects().length > 0 &&
            el.getAttribute('aria-hidden') !== 'true' &&
            !(el as HTMLButtonElement).disabled)
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
    }
    document.addEventListener('keydown', onKey)

    // Move focus into the dialog when it opens. Only real form controls are
    // candidates — NOT plain <button>, since the header's close (X) button
    // is a <button> that sits before the form fields in the DOM and would
    // otherwise win the query every time. Confirmations focus the container
    // (not a control) so a held Enter key can't accidentally trigger a
    // destructive action.
    setTimeout(() => {
      if (contentRef.current && !contentRef.current.contains(document.activeElement)) {
        const firstInput = isConfirmationRef.current
          ? null
          : contentRef.current.querySelector('input:not([type="hidden"]), textarea, select, [contenteditable="true"]') as HTMLElement | null
        if (firstInput) {
          firstInput.focus()
        } else {
          contentRef.current.focus()
        }
      }
    }, 10)

    return () => {
      document.body.style.overflow = originalStyle
      document.removeEventListener('keydown', onKey)
      // Restore focus to whatever opened the dialog, if it's still in the DOM.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus()
      }
    }
    // Intentionally empty: onClose/isConfirmation are read via refs above so
    // this setup (body-scroll lock, keydown listener, initial focus) runs
    // exactly once when the modal mounts, not on every parent re-render.
     
  }, [])

  // Alignment: centered dialog by default; bottom-anchored sheet on mobile when opted in.
  // Padding: zero on mobile sheet (so the sheet hugs the viewport), p-4 on desktop.
  const alignment = sheetOnMobile
    ? 'items-end justify-center sm:items-center'
    : 'items-center justify-center'
  const padding = sheetOnMobile ? 'p-0 sm:p-4' : 'p-4'

  return (
    <div
      // Hook for the side-panel coexistence rule in globals.css: while a
      // slide-over (Discuss) is open it stamps `data-side-panel-open` on
      // <html>, and that rule reserves room here so this dialog shifts left
      // instead of being covered. Purely declarative, so a modal opened while
      // the panel is already open is offset on its first paint too.
      // See src/components/ui/side-panel-room.ts.
      data-modal-overlay
      className={`fixed inset-0 ${zIndex} flex ${alignment} bg-black/60 backdrop-blur-sm ${padding} ${className}`}
      onMouseDown={e => {
        if (!isConfirmation && contentRef.current && !contentRef.current.contains(e.target as Node)) {
          onClose()
        }
      }}
    >
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={sheetOnMobile ? "w-full max-h-[90dvh] sm:max-h-[85dvh] sm:w-auto flex flex-col focus:outline-none" : "w-full max-h-[90dvh] flex flex-col focus:outline-none max-w-fit"}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  )
}
