'use client'

/**
 * The shared rendering of a form's save state.
 *
 * One place, one wording, one position — beside the submit button, above the
 * fold of the action row — so a staff member learns the pattern once instead
 * of per screen. The states themselves are in `@/lib/forms/submit-state`.
 *
 * Renders nothing while idle, so it can be dropped into an action row
 * unconditionally.
 *
 * `role="alert"` only for errors: a polite status for "saving" would have a
 * screen reader interrupt every submit, while a failure genuinely needs
 * announcing.
 */
import { Loader2, Check, AlertCircle } from 'lucide-react'
import type { SubmitState } from '@/lib/forms/submit-state'

export function FormStatus({
  state, className = '',
}: {
  state: SubmitState
  className?: string
}) {
  if (state.status === 'idle') return null

  if (state.status === 'saving') {
    return (
      <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground ${className}`}>
        <Loader2 className="w-3 h-3 shrink-0 animate-spin" />
        Saving…
      </span>
    )
  }

  if (state.status === 'saved') {
    return (
      <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 ${className}`}>
        <Check className="w-3 h-3 shrink-0" />
        Saved
      </span>
    )
  }

  return (
    <span
      role="alert"
      className={`inline-flex items-start gap-1.5 text-[11px] font-medium text-destructive ${className}`}
    >
      <AlertCircle className="w-3 h-3 shrink-0 mt-px" />
      <span>{state.message}</span>
    </span>
  )
}
