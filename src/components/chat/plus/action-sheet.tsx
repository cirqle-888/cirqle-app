'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'

export interface SheetItem {
  key: string
  label: string
  icon: LucideIcon
  onSelect: () => void
  danger?: boolean
  /** Shown on the right, e.g. the current setting. */
  hint?: string
}

/**
 * One menu, two shapes: a bottom sheet on a phone (thumb reach, like
 * WhatsApp's press-and-hold menu) and a small floating menu at the pointer on
 * a computer (like Slack's right-click). `header` is for the reaction row.
 */
export function ActionSheet({ items, header, title, anchor, onClose }: {
  items: SheetItem[]
  header?: React.ReactNode
  title?: string
  /** Where the pointer was. Ignored on a phone. */
  anchor?: { x: number; y: number } | null
  onClose: () => void
}) {
  const [phone] = useState(() => typeof window !== 'undefined' && (window.innerWidth < 768 || window.matchMedia('(pointer: coarse)').matches))
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Keep the floating menu inside the window.
  useLayoutEffect(() => {
    if (phone || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    const x = anchor?.x ?? window.innerWidth / 2, y = anchor?.y ?? window.innerHeight / 2
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    })
  }, [phone, anchor])

  const run = (fn: () => void) => { onClose(); fn() }
  const list = (
    <div className="py-1">
      {items.map(it => (
        <button key={it.key} type="button" onClick={() => run(it.onSelect)}
          className={`flex w-full items-center gap-3 px-4 text-left text-sm hover:bg-muted active:bg-muted ${phone ? 'py-3' : 'py-2'} ${it.danger ? 'text-red-500' : ''}`}>
          <it.icon className="h-4 w-4 shrink-0 opacity-80" />
          <span className="flex-1">{it.label}</span>
          {it.hint && <span className="text-xs text-muted-foreground">{it.hint}</span>}
        </button>
      ))}
    </div>
  )

  return createPortal(
    <div className="fixed inset-0 z-[210]" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
      onContextMenu={e => { e.preventDefault(); onClose() }}>
      {phone ? (
        <>
          <div className="absolute inset-0 bg-black/50" onClick={onClose} />
          <div ref={ref} role="menu" aria-label={title ?? 'Actions'}
            className="absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl border-t border-border bg-background pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-2xl">
            <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-muted-foreground/30" />
            {title && <p className="truncate px-4 pt-3 text-xs text-muted-foreground">{title}</p>}
            {header && <div className="px-3 pt-3">{header}</div>}
            {list}
          </div>
        </>
      ) : (
        <div ref={ref} role="menu" aria-label={title ?? 'Actions'}
          style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
          className="absolute w-64 overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
          {header && <div className="border-b border-border p-2">{header}</div>}
          {list}
        </div>
      )}
    </div>,
    document.body,
  )
}
