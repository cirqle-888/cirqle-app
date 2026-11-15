'use client'

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react'

/**
 * Drag-to-dismiss for a bottom sheet.
 *
 * A sheet that draws a grab handle has to be grabbable. This gives a sheet the
 * three things that make that feel right:
 *
 *  - It follows the finger 1:1 while the pointer is down. The transform is
 *    written straight onto the element — no React state per move event, which
 *    would re-render on every frame of the drag.
 *  - On release it is dismissed by distance OR by speed, so a short quick
 *    flick closes it just as dragging it most of the way down does.
 *  - It can be caught mid-flight. Enter, snap-back and close are CSS
 *    transitions, never keyframes, so grabbing the sheet while it is still
 *    moving continues from where it is on screen instead of jumping.
 *
 * The backdrop's opacity is derived from the drag position rather than
 * animated on its own, so it is always exactly as faded as the sheet is
 * dismissed — including when the user reverses direction.
 *
 * Usage:
 *   const { sheetRef, backdropRef, sheetProps, dismiss } = useSheetDismiss(onClose)
 *   <div ref={backdropRef} onClick={dismiss} />
 *   <div ref={sheetRef} {...sheetProps} className="… touch-none" />
 *
 * The sheet element needs `touch-action: none` (`touch-none`) so the browser
 * does not start a scroll or pull-to-refresh with the same finger. That makes
 * this the wrong tool for a sheet whose content scrolls.
 *
 * The global reduced-motion rule in globals.css clamps the transitions to
 * near-zero; the drag itself stays, because the user is producing that motion.
 */

/** How far a press must travel before it counts as a drag rather than a tap. */
const DRAG_START_PX = 10
/** Downward release speed, in px/ms, that dismisses regardless of distance. */
const DISMISS_VELOCITY = 0.11
/** …or how much of the sheet's own height it must have been dragged down. */
const DISMISS_FRACTION = 0.45
/** Resistance when dragging up past the resting position (Apple's constant). */
const RUBBER_BAND = 0.55
/** Only pointer samples this recent count toward the release speed. */
const VELOCITY_WINDOW_MS = 100
/** The `--ease-drawer` token and the 500ms that curve is designed for. The
 *  literal fallback matters: an unresolved var() would make the whole inline
 *  `transition` invalid, and the sheet would jump instead of slide. */
const SETTLE_MS = 500
const SETTLE = `${SETTLE_MS}ms var(--ease-drawer, cubic-bezier(0.32, 0.72, 0, 1))`

interface DragState {
  pointerId: number
  startY: number
  /** Pointer travel at the moment the press became a drag. */
  grabDy: number
  /** Where the sheet was on screen when grabbed (non-zero if caught mid-flight). */
  baseY: number
  dragging: boolean
  samples: Array<{ t: number; y: number }>
}

/** The further past the bound, the less the element follows. */
function rubberBand(overshoot: number, dimension: number): number {
  return (overshoot * dimension * RUBBER_BAND) / (dimension + RUBBER_BAND * overshoot)
}

/** The sheet's current on-screen vertical offset, even mid-transition. */
function currentTranslateY(el: HTMLElement): number {
  const t = getComputedStyle(el).transform
  if (!t || t === 'none') return 0
  return new DOMMatrixReadOnly(t).m42
}

export function useSheetDismiss(onClose: () => void) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const drag = useRef<DragState | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Set when a drag has just ended, so the click it produces is swallowed. */
  const suppressClick = useRef(false)

  // Read through a ref so the callbacks below stay stable even though almost
  // every caller passes a fresh inline `onClose` on each render.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  const setTransition = useCallback((on: boolean) => {
    const sheet = sheetRef.current
    const backdrop = backdropRef.current
    if (sheet) sheet.style.transition = on ? `transform ${SETTLE}` : 'none'
    if (backdrop) backdrop.style.transition = on ? `opacity ${SETTLE}` : 'none'
  }, [])

  const place = useCallback((y: number, height: number) => {
    const sheet = sheetRef.current
    const backdrop = backdropRef.current
    if (sheet) sheet.style.transform = `translateY(${y}px)`
    if (backdrop && height > 0) {
      backdrop.style.opacity = String(1 - Math.min(Math.max(y / height, 0), 1))
    }
  }, [])

  const cancelPendingClose = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
  }, [])

  /** Slide back up to rest. */
  const settleOpen = useCallback(() => {
    setTransition(true)
    const sheet = sheetRef.current
    const backdrop = backdropRef.current
    if (sheet) sheet.style.transform = 'translateY(0)'
    if (backdrop) backdrop.style.opacity = '1'
  }, [setTransition])

  /** Slide out the way it came in, then tell the owner to unmount it. */
  const dismiss = useCallback(() => {
    if (closeTimer.current) return
    setTransition(true)
    const sheet = sheetRef.current
    const backdrop = backdropRef.current
    if (sheet) sheet.style.transform = 'translateY(100%)'
    if (backdrop) backdrop.style.opacity = '0'
    // A timer rather than `transitionend`: that event never fires when the
    // sheet is already at its target, which would leave it mounted for good.
    const reduced = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      onCloseRef.current()
    }, reduced ? 0 : SETTLE_MS)
  }, [setTransition])

  // Entrance: start one sheet-height down and transition up. A transition,
  // not a keyframe animation, so the sheet can be grabbed while it arrives.
  useLayoutEffect(() => {
    const sheet = sheetRef.current
    const backdrop = backdropRef.current
    if (!sheet) return
    sheet.style.transition = 'none'
    sheet.style.transform = 'translateY(100%)'
    if (backdrop) { backdrop.style.transition = 'none'; backdrop.style.opacity = '0' }
    // Force the starting position to be committed before the transition is set.
    void sheet.getBoundingClientRect()
    settleOpen()
    return cancelPendingClose
  }, [settleOpen, cancelPendingClose])

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // A press that never became a drag can end outside the sheet, where its
    // pointerup is never seen — so only an actual drag in progress blocks this.
    if (drag.current?.dragging) return
    drag.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      grabDy: 0,
      baseY: 0,
      dragging: false,
      samples: [{ t: e.timeStamp, y: e.clientY }],
    }
  }, [])

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const sheet = sheetRef.current
    if (!d || !sheet || e.pointerId !== d.pointerId) return
    // The mouse button was let go somewhere this element could not see.
    if (e.pointerType === 'mouse' && e.buttons === 0 && !d.dragging) { drag.current = null; return }
    const dy = e.clientY - d.startY

    if (!d.dragging) {
      if (Math.abs(dy) < DRAG_START_PX) return
      // It is a drag now. Take over from wherever the sheet is on screen —
      // it may be mid-entrance, mid-snap-back, or already on its way out.
      cancelPendingClose()
      d.dragging = true
      d.grabDy = dy
      d.baseY = currentTranslateY(sheet)
      setTransition(false)
      // Keep receiving moves when the finger leaves the sheet. Capture can be
      // refused if the pointer is already gone; the drag still works without it.
      try { sheet.setPointerCapture(e.pointerId) } catch { /* pointer no longer active */ }
    }

    const height = sheet.offsetHeight
    let y = d.baseY + (dy - d.grabDy)
    if (y < 0) y = -rubberBand(-y, height)
    place(y, height)

    d.samples.push({ t: e.timeStamp, y: e.clientY })
    if (d.samples.length > 8) d.samples.shift()
  }, [cancelPendingClose, setTransition, place])

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current
    const sheet = sheetRef.current
    if (!d || e.pointerId !== d.pointerId) return
    drag.current = null
    if (!d.dragging || !sheet) return

    if (sheet.hasPointerCapture(e.pointerId)) sheet.releasePointerCapture(e.pointerId)
    // The release of a drag also produces a click; it must not press a button.
    suppressClick.current = true
    setTimeout(() => { suppressClick.current = false }, 0)

    // Release speed from the last ~100ms of movement only, so a drag that
    // paused before letting go is not read as a flick.
    const recent = d.samples.filter(s => e.timeStamp - s.t <= VELOCITY_WINDOW_MS)
    const first = recent[0]
    const elapsed = first ? e.timeStamp - first.t : 0
    const velocity = first && elapsed > 0 ? (e.clientY - first.y) / elapsed : 0

    const y = currentTranslateY(sheet)
    const height = sheet.offsetHeight
    const flickedDown = velocity > DISMISS_VELOCITY && y > 0
    const draggedFar = y > height * DISMISS_FRACTION

    if (!cancelled && (flickedDown || draggedFar)) dismiss()
    else settleOpen()
  }, [dismiss, settleOpen])

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => endDrag(e, false), [endDrag])
  const onPointerCancel = useCallback((e: ReactPointerEvent<HTMLDivElement>) => endDrag(e, true), [endDrag])

  const onClickCapture = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClick.current) return
    suppressClick.current = false
    e.preventDefault()
    e.stopPropagation()
  }, [])

  return {
    sheetRef,
    backdropRef,
    dismiss,
    sheetProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture },
  }
}
