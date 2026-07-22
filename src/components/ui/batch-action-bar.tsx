'use client'

import { X, Loader2 } from 'lucide-react'

export type BatchActionTint = 'emerald' | 'violet' | 'blue' | 'yellow' | 'red' | 'amber' | 'cyan' | 'orange'

export interface BatchAction {
  key: string
  label: string
  icon: React.ReactNode
  tint: BatchActionTint
  onClick: () => void
  disabled?: boolean
}

const TINTS: Record<BatchActionTint, string> = {
  emerald: 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border-emerald-500/20',
  violet:  'bg-violet-500/15 text-violet-700 dark:text-violet-300 hover:bg-violet-500/25 border-violet-500/20',
  blue:    'bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 border-blue-500/20',
  yellow:  'bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25 border-yellow-500/20',
  red:     'bg-red-500/15 text-red-400 hover:bg-red-500/25 border-red-500/20',
  amber:   'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 border-amber-500/20',
  cyan:    'bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 border-cyan-500/20',
  orange:  'bg-orange-500/15 text-orange-400 hover:bg-orange-500/25 border-orange-500/20',
}

/**
 * Floating bottom action bar for multi-select batch operations — the same
 * select → action bar → execute pattern across every module (Tasks,
 * Invoices, Requests, ...) instead of each page inventing its own toolbar.
 * Visually identical to the original Tasks bulk bar (the proven pattern),
 * just generalized so other pages can reuse it.
 */
export function BatchActionBar({ count, onClear, actions, busy }: {
  count: number
  onClear: () => void
  actions: BatchAction[]
  busy?: boolean
}) {
  if (count === 0) return null
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-center gap-2 bg-secondary border border-foreground/20 rounded-2xl shadow-2xl shadow-black/60 px-4 py-3 flex-wrap max-w-[95vw]">
        <span className="text-xs font-semibold text-muted-foreground pr-2 border-r border-foreground/15 shrink-0">
          {count} selected
        </span>
        {busy ? (
          <span className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Working…
          </span>
        ) : (
          actions.map(a => (
            <button
              key={a.key}
              onClick={a.onClick}
              disabled={a.disabled}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors border disabled:opacity-40 disabled:cursor-not-allowed ${TINTS[a.tint]}`}
            >
              {a.icon} {a.label}
            </button>
          ))
        )}
        <button onClick={onClear} disabled={busy}
          className="ml-1 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] transition-colors shrink-0 disabled:opacity-40">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
