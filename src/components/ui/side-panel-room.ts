'use client'

/**
 * Side-panel ↔ modal coexistence — the shared rule, in one place.
 *
 * A slide-over panel (today: the Discuss chatter) is `position: fixed` on the
 * right edge, so it covers any centred <ModalOverlay> dialog — hiding the very
 * record being discussed. While a panel is open we reserve its width on the
 * right of every overlay; each dialog re-centres into the space that's left.
 *
 * WHY A CSS VARIABLE AND NOT INLINE STYLES: the offset must apply to modals
 * that open *while* the panel is already open (open Discuss from a task row,
 * then click the row to edit it). Writing inline padding onto the overlays
 * present at panel-mount time can't do that — a later modal mounts centred and
 * stays covered. Stamping <html> instead lets the static rule in globals.css
 * (`[data-side-panel-open] [data-modal-overlay]`) style current AND future
 * overlays, and one attribute removal restores them all.
 *
 * Ref-counted so overlapping panels compose: room is released only once the
 * last holder lets go. The widest active reservation wins, so a wide panel is
 * never under-provisioned by a narrower one closing.
 *
 * The `md`-and-up restriction lives in the CSS, not here — below that a dialog
 * and a 400px panel cannot share the width, and the panel covers as a sheet.
 */

import { useEffect } from 'react'

/** Widths of every currently-open panel, keyed by reservation token. */
const reservations = new Map<symbol, number>()

function apply() {
  const root = document.documentElement
  if (reservations.size === 0) {
    root.removeAttribute('data-side-panel-open')
    root.style.removeProperty('--side-panel-w')
    return
  }
  root.style.setProperty('--side-panel-w', `${Math.max(...reservations.values())}px`)
  root.setAttribute('data-side-panel-open', '')
}

/**
 * Reserve `width` px of room for a side panel. Returns the release function —
 * call it when the panel closes. Safe to call twice (idempotent release), which
 * matters under React StrictMode's double-invoked effects.
 *
 * Imperative entry point for non-React callers; React components should prefer
 * {@link useSidePanelRoom}.
 */
export function reserveSidePanelRoom(width: number): () => void {
  const token = Symbol('side-panel')
  reservations.set(token, width)
  apply()
  return () => {
    if (!reservations.delete(token)) return
    apply()
  }
}

/** Reserve room for as long as the calling component is mounted. */
export function useSidePanelRoom(width: number): void {
  useEffect(() => reserveSidePanelRoom(width), [width])
}
