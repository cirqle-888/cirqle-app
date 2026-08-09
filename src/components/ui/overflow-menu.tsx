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
 */

import { useEffect, useRef, useState } from 'react'
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
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click and on Escape — the two behaviours users expect of
  // any menu, and the reason screens should not hand-roll their own.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (items.length === 0) return null

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        className="flex items-center justify-center text-muted-foreground hover:text-foreground border border-border rounded-lg px-2.5 py-2 bg-secondary hover:bg-secondary/80 transition-colors"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute z-50 mt-1.5 min-w-[13rem] rounded-xl border border-border bg-card p-1 shadow-lg animate-in fade-in zoom-in-95 ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
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
        </div>
      )}
    </div>
  )
}
