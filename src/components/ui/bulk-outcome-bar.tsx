'use client'

/**
 * What happened to a bulk action, and what to do about the part that didn't.
 *
 * Sits above the list after a bulk run. A clean run says so and goes away; a
 * partial failure stays until dismissed and offers to retry exactly the rows
 * that were refused — which is the difference between finishing the job and
 * re-running the whole selection and hoping.
 *
 * Renders nothing for a clean or empty run, so it can be mounted
 * unconditionally.
 */
import { AlertTriangle, RotateCcw, XCircle } from 'lucide-react'
import type { BulkReport } from '@/lib/bulk/outcome'

export function BulkOutcomeBar({
  report, onRetry, onDismiss, busy = false, className = '',
}: {
  report: BulkReport | null
  /** Re-run the action against `report.retryable` only. */
  onRetry: () => void
  onDismiss: () => void
  busy?: boolean
  className?: string
}) {
  if (!report || report.tone === 'success' || report.tone === 'empty') return null

  const total = report.tone === 'failure'
  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 rounded-xl border text-xs ${
        total ? 'border-red-500/30 bg-red-500/10' : 'border-amber-500/30 bg-amber-500/10'
      } ${className}`}
    >
      {total
        ? <XCircle className="w-4 h-4 shrink-0 text-red-500" />
        : <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />}
      <div className="flex-1 min-w-[200px]">
        <p className="font-semibold">{report.title}</p>
        {report.body && <p className="text-muted-foreground mt-0.5">{report.body}</p>}
      </div>
      <div className="flex items-center gap-1.5">
        {report.retryable.length > 0 && (
          <button
            type="button"
            onClick={onRetry}
            disabled={busy}
            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[11px] font-semibold bg-foreground/10 hover:bg-foreground/15 disabled:opacity-40 transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Retry {report.retryable.length}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="h-8 px-2.5 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors cursor-pointer"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
