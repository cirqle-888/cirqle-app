'use client'

/**
 * The two pieces of UI a recoverable draft needs.
 *
 * `DraftRecoveryBanner` offers an unsent draft back when a form opens, and
 * `DraftSavedHint` shows the last autosave time while the form is in use —
 * the plan asks for that time to be displayed, and it is also the only thing
 * that makes autosave believable: silence looks identical to "not working".
 *
 * Both render nothing when there is nothing to say, so they can be dropped
 * into a form unconditionally.
 */
import { RotateCcw, Trash2, Check } from 'lucide-react'
import type { FormDraft } from '@/lib/drafts/use-form-draft'

export function DraftRecoveryBanner<T>({
  draft, onRestore, label = 'Unsent draft', className = '',
}: {
  draft: FormDraft<T>
  /** Apply the recovered values. The form owns its state; this hook never writes into it. */
  onRestore: (data: T) => void
  /** What was being drafted, e.g. "Unsent task". */
  label?: string
  className?: string
}) {
  if (draft.recovered === null) return null
  return (
    <div
      role="status"
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 ${className}`}
    >
      <div className="flex-1 min-w-[180px]">
        <p className="text-xs font-semibold text-amber-800 dark:text-amber-200">{label} recovered</p>
        <p className="text-[11px] text-amber-700/80 dark:text-amber-300/70">
          Last edited {draft.recoveredAtLabel}. Nothing was submitted.
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            const data = draft.restore()
            if (data !== null) onRestore(data)
          }}
          className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[11px] font-semibold bg-amber-500/20 text-amber-800 dark:text-amber-200 hover:bg-amber-500/30 transition-colors cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Restore
        </button>
        <button
          type="button"
          onClick={draft.discard}
          title="Delete this draft"
          className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Discard
        </button>
        <button
          type="button"
          onClick={draft.dismiss}
          title="Keep the draft but start fresh here"
          className="h-8 px-2.5 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          Not now
        </button>
      </div>
    </div>
  )
}

export function DraftSavedHint<T>({ draft, className = '' }: { draft: FormDraft<T>; className?: string }) {
  if (!draft.savedAtLabel) return null
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground/70 ${className}`}>
      <Check className="w-3 h-3 shrink-0" />
      Draft saved {draft.savedAtLabel}
    </span>
  )
}
