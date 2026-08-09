'use client'

/**
 * Empty state — one style for every "nothing here yet" in the app.
 *
 * Before this existed, list screens ranged from a bare "No data" to two
 * different private EmptyState components. A bare string tells you nothing:
 * the reader cannot tell whether something is broken, filtered out, or simply
 * not created yet. So `body` is required — it must say WHY the list is empty
 * and what would fill it.
 */

import type { LucideIcon } from 'lucide-react'

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  compact,
}: {
  icon?: LucideIcon
  /** The state, in plain words: "No invoices yet". */
  title: string
  /** Why it is empty and what fills it. Required on purpose. */
  body: string
  /** The one obvious next step, when there is one. */
  action?: { label: string; onClick: () => void }
  /** Tighter padding for panels nested inside a card. */
  compact?: boolean
}) {
  return (
    <div className={`text-center ${compact ? 'px-4 py-8' : 'px-4 py-14'}`}>
      {Icon && (
        <div className="mx-auto mb-3 w-10 h-10 rounded-xl bg-secondary flex items-center justify-center">
          <Icon className="w-5 h-5 text-muted-foreground" />
        </div>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground mt-1.5 max-w-sm mx-auto leading-relaxed">{body}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg gradient-bg px-3.5 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
