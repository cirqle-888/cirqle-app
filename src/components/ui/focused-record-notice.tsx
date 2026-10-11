'use client'

/**
 * Explains a deep link that did not land on a visible row.
 *
 * Every Cirqle list screen is windowed and then filtered, so a link to a
 * specific record can arrive on a screen that does not show it. Until now the
 * focus handlers returned early in that case, which looked exactly like a
 * broken link. This says which of the two things happened — hidden by the
 * filters, or not loaded at all — and in the first case offers the one click
 * that fixes it.
 *
 * Renders nothing for 'none' and 'visible', so it can be mounted
 * unconditionally; `outcome` comes straight from `resolveFocus`.
 */
import { Eye, SearchX } from 'lucide-react'
import type { FocusOutcome } from '@/lib/navigation/focus-record'

export function FocusedRecordNotice({
  outcome, what, label, onShow, onDismiss, className = '',
}: {
  outcome: FocusOutcome<unknown>['kind']
  /** Singular noun for the record type, e.g. "entry", "task". */
  what: string
  /** How to name the record — reference and date, never an amount. */
  label?: string
  /** Clear the filters that are hiding it. */
  onShow: () => void
  onDismiss: () => void
  className?: string
}) {
  if (outcome === 'none' || outcome === 'visible') return null

  const hidden = outcome === 'hidden'
  return (
    <div
      role="status"
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 rounded-xl border text-xs ${
        hidden
          ? 'border-violet-500/30 bg-violet-500/10'
          : 'border-foreground/15 bg-secondary'
      } ${className}`}
    >
      {hidden
        ? <Eye className="w-4 h-4 shrink-0 text-violet-600 dark:text-violet-300" />
        : <SearchX className="w-4 h-4 shrink-0 text-muted-foreground" />}
      <p className="flex-1 min-w-[200px] font-medium">
        {hidden ? (
          <>
            <span className="font-semibold">{label}</span>
            {' '}is hidden by your current filters.
          </>
        ) : (
          <>
            That {what} could not be opened here — it may have been deleted, or it
            falls outside the history this screen loads.
          </>
        )}
      </p>
      <div className="flex items-center gap-1.5">
        {hidden && (
          <button
            type="button"
            onClick={onShow}
            className="h-8 px-2.5 rounded-lg text-[11px] font-semibold bg-violet-500/20 text-violet-800 dark:text-violet-200 hover:bg-violet-500/30 transition-colors cursor-pointer"
          >
            Show it
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="h-8 px-2.5 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
