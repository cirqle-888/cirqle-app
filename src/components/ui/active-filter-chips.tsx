'use client'

import { X } from 'lucide-react'

export interface FilterChip {
  /** Stable key for React lists. */
  key: string
  /** Filter category, e.g. "Client". */
  label: string
  /** Selected value, e.g. "Sea Star Catering". */
  value: string
  onRemove: () => void
}

/**
 * Tokenized active-filter chips (ERPNext/Odoo style): every applied filter
 * shows as a removable pill above the results, plus a "Clear all" affordance.
 * Renders nothing when no filters are active — safe to mount unconditionally.
 */
export function ActiveFilterChips({
  chips, onClearAll, className = '',
}: {
  chips: FilterChip[]
  onClearAll?: () => void
  className?: string
}) {
  if (chips.length === 0) return null
  return (
    <div className={`flex items-center gap-1.5 flex-wrap ${className}`}>
      {chips.map(c => (
        <span key={c.key}
          className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full text-[11px] bg-violet-500/10 text-violet-300 border border-violet-500/25">
          <span className="text-violet-400/70 font-medium">{c.label}:</span>
          <span className="font-semibold max-w-[160px] truncate">{c.value}</span>
          <button
            onClick={c.onRemove}
            aria-label={`Remove ${c.label} filter`}
            className="p-0.5 rounded-full hover:bg-violet-500/25 transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      {chips.length > 1 && onClearAll && (
        <button onClick={onClearAll}
          className="text-[11px] text-muted-foreground hover:text-foreground px-1.5 py-1 transition-colors">
          Clear all
        </button>
      )}
    </div>
  )
}
