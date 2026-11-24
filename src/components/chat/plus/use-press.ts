'use client'

import { useRef, useState } from 'react'

const HOLD_MS = 420
const SWIPE_TRIGGER = 56
const SWIPE_MAX = 72

/**
 * Touch gestures for a message row: press and hold opens the menu, swipe right
 * replies, two quick taps give a heart. A finger that moves is scrolling, not holding — so vertical movement
 * cancels both, and a swipe only starts once it is clearly sideways.
 */
export function useMessageGestures({ onHold, onSwipeReply, onDoubleTap }: {
  onHold?: (point: { x: number; y: number }) => void
  onSwipeReply?: () => void
  /** Two quick taps on the same spot — the heart, as on Instagram. */
  onDoubleTap?: () => void
}) {
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mode = useRef<'idle' | 'swipe' | 'scroll' | 'held'>('idle')
  const [dx, setDx] = useState(0)
  const dxRef = useRef(0)

  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }

  return {
    dx,
    /** True right after a hold fired — lets the row ignore the click that follows. */
    wasHeld: () => mode.current === 'held',
    handlers: {
      onTouchStart: (e: React.TouchEvent) => {
        if (e.touches.length !== 1) return
        const t = e.touches[0]
        start.current = { x: t.clientX, y: t.clientY }
        mode.current = 'idle'
        clear()
        if (onHold) {
          timer.current = setTimeout(() => {
            if (mode.current !== 'idle' || !start.current) return
            mode.current = 'held'
            try { navigator.vibrate?.(12) } catch { /* not supported */ }
            onHold(start.current)
          }, HOLD_MS)
        }
      },
      onTouchMove: (e: React.TouchEvent) => {
        if (!start.current || mode.current === 'held' || mode.current === 'scroll') return
        const t = e.touches[0]
        const mx = t.clientX - start.current.x, my = t.clientY - start.current.y
        if (mode.current === 'idle') {
          if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { mode.current = 'scroll'; clear(); return }
          if (mx > 12 && Math.abs(mx) > Math.abs(my) * 1.5 && onSwipeReply) { mode.current = 'swipe'; clear() }
          else if (Math.abs(mx) > 10) clear()
        }
        if (mode.current === 'swipe') {
          dxRef.current = Math.max(0, Math.min(SWIPE_MAX, mx))
          setDx(dxRef.current)
        }
      },
      onTouchEnd: () => {
        clear()
        if (mode.current === 'swipe' && dxRef.current >= SWIPE_TRIGGER) {
          try { navigator.vibrate?.(8) } catch { /* not supported */ }
          onSwipeReply?.()
        }
        // A tap that neither moved nor held: is it the second of a pair?
        if (mode.current === 'idle' && start.current && onDoubleTap) {
          const now = Date.now(), prev = lastTap.current, here = start.current
          if (prev && now - prev.at < 320 && Math.abs(prev.x - here.x) < 28 && Math.abs(prev.y - here.y) < 28) {
            lastTap.current = null
            try { navigator.vibrate?.(8) } catch { /* not supported */ }
            onDoubleTap()
          } else lastTap.current = { at: now, x: here.x, y: here.y }
        }
        dxRef.current = 0
        setDx(0)
        start.current = null
        // Leave 'held' set for the click that follows, then reset.
        if (mode.current === 'held') setTimeout(() => { mode.current = 'idle' }, 350)
        else mode.current = 'idle'
      },
      onTouchCancel: () => { clear(); dxRef.current = 0; setDx(0); start.current = null; mode.current = 'idle' },
    },
  }
}
