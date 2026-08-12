'use client'

/**
 * Overflow menu — the "…" that holds a screen's secondary actions.
 *
 * Header toolbars had grown to the point where the Tasks page title truncated
 * to "T…" to make room for buttons. The rule this component exists to enforce:
 * ONE primary action stays visible, everything else lives behind the "…".
 *
 * Nothing is removed by using it — every action remains one click away, and
 * each keeps its own permission gate at the call site.
 *
 * The panel is PORTALLED to <body>. Header action rows are `overflow-x-auto`
 * and <main> is `overflow-y-auto`, so an absolutely-positioned panel rendered
 * in place is clipped by them: it mounts, reports a sane size and full
 * opacity, and is still invisible and unclickable. Same reason FilterDropdown
 * portals its panel.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal, type LucideIcon } from 'lucide-react'

export interface OverflowItem {
  label: string
  icon?: LucideIcon
  onClick: () => void
  /** Right-aligned count/status, e.g. a Trash item count. */
  badge?: string | number
  /** Renders in red — reserve for destructive entries. */
  danger?: boolean
  disabled?: boolean
  /** Draws a divider above this item, for separating destructive entries. */
  separatorBefore?: boolean
}

const PANEL_W = 224
const MARGIN = 8

export function OverflowMenu({
  items,
  label = 'More actions',
  align = 'right',
}: {
  items: OverflowItem[]
  label?: string
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Position against the trigger in viewport coordinates, clamped so the panel
  // can never hang off either edge on a narrow screen.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    const left = align === 'right' ? r.right - PANEL_W : r.left
    setPos({
      top: r.bottom + 6,
      left: Math.max(MARGIN, Math.min(left, window.innerWidth - PANEL_W - MARGIN)),
    })
  }, [open, align])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    // Scrolling or resizing moves the trigger out from under a fixed panel,
    // so close rather than leave it stranded mid-air.
    const onMove = () => setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open])

  if (items.length === 0) return null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        className="shrink-0 flex items-center justify-center text-muted-foreground hover:text-foreground border border-border rounded-lg px-2.5 py-2 bg-secondary hover:bg-secondary/80 transition-colors"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>

      {open && pos && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          role="menu"
          data-overflow-menu-panel="true"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: PANEL_W }}
          className="z-[120] rounded-xl border border-border bg-card p-1 shadow-lg"
        >
          {items.map((item, i) => {
            const Icon = item.icon
            return (
              <div key={item.label}>
                {item.separatorBefore && i > 0 && <div className="my-1 h-px bg-border" />}
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => { setOpen(false); item.onClick() }}
                  className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    item.danger
                      ? 'text-red-500 hover:bg-red-500/10'
                      : 'text-foreground hover:bg-secondary'
                  }`}
                >
                  {Icon && <Icon className="w-4 h-4 shrink-0 opacity-70" />}
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.badge != null && item.badge !== '' && (
                    <span className="shrink-0 text-[10px] rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 font-semibold bg-foreground/10 text-muted-foreground">
                      {item.badge}
                    </span>
                  )}
                </button>
              </div>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}
