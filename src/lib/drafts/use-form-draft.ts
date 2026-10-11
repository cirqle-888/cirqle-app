'use client'

/**
 * `useFormDraft` — autosave and recovery for one form.
 *
 * Adoption is two lines in the form that already exists:
 *
 *   const draft = useFormDraft('task.new', values, { enabled: isOpen })
 *   // …render <DraftRecoveryBanner draft={draft} onRestore={setValues} />
 *   // …on success: draft.clear()
 *
 * The form keeps owning its state. This hook only mirrors that state to
 * durable storage while it is being edited, and tells the form whether an
 * unsent draft was waiting when it opened. It never writes into the form by
 * itself: `restore()` hands the data back and the form applies it, so a
 * recovered draft can never overwrite something the user has already started
 * typing without them asking for it.
 *
 * Scope comes from the signed-in employee and the active workspace, read from
 * context rather than passed in, so no caller can accidentally widen it.
 * Submission is untouched — see the note in `model.ts`.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { usePermissions } from '@/contexts/permission-context'
import { useWorkspace } from '@/contexts/workspace-context'
import { readDraft, writeDraft, clearDraft, pruneForeignDrafts } from './store'
import { isMeaningfulDraft, formatLastSaved, type DraftScope } from './model'

/** Long enough that typing a sentence is one write, short enough to survive a slip. */
const AUTOSAVE_DEBOUNCE_MS = 800

/** How often the rendered "2 minutes ago" is allowed to go stale. */
const CLOCK_TICK_MS = 30_000

export interface FormDraft<T> {
  /**
   * An unsent draft that was waiting when the form opened, still on offer.
   * `null` once restored, dismissed or discarded — and whenever there was
   * nothing to recover.
   */
  recovered: T | null
  /** When the *recovered* draft was last written, as a label ("2 minutes ago"). */
  recoveredAtLabel: string | null
  /** When the current editing session last autosaved, as a label. */
  savedAtLabel: string | null
  /** Take the recovered draft and stop offering it. The caller applies it. */
  restore: () => T | null
  /** Stop offering it but keep it stored — the user may still want it later. */
  dismiss: () => void
  /** Delete it. Used by an explicit "discard draft" control. */
  discard: () => void
  /** Delete it after a successful submission. Safe to call unconditionally. */
  clear: () => void
}

/**
 * Per-editing-session state, stamped with the session it belongs to.
 *
 * Stamping and discarding it during render — rather than clearing it from an
 * effect when the form closes — is what keeps one form's recovered draft and
 * save time from leaking into the next thing opened in the same component.
 */
interface Session<T> {
  key: string | null
  recovered: T | null
  recoveredAt: number | null
  savedAt: number | null
}

const EMPTY_SESSION = { recovered: null, recoveredAt: null, savedAt: null } as const

export function useFormDraft<T>(
  formKey: string,
  value: T,
  opts: {
    /** Autosave only while the form is actually open/editable. */
    enabled?: boolean
    /** Sharper notion of "empty" than the default structural check. */
    isMeaningful?: (value: T) => boolean
  } = {},
): FormDraft<T> {
  const { enabled = true, isMeaningful } = opts
  const { user } = usePermissions()
  const { current: workspace } = useWorkspace()

  const scope = useMemo<DraftScope>(
    () => ({ employeeId: user.employeeId, workspaceId: workspace.id }),
    [user.employeeId, workspace.id],
  )
  const active = enabled && !!scope.employeeId && !!scope.workspaceId
  const sessionKey = active ? `${scope.employeeId}|${scope.workspaceId}|${formKey}` : null

  const [session, setSession] = useState<Session<T>>({ key: null, ...EMPTY_SESSION })
  const live = sessionKey !== null && session.key === sessionKey ? session : EMPTY_SESSION

  /** Bumped on a timer so a rendered relative timestamp keeps up. */
  const [clock, setClock] = useState(() => Date.now())

  /**
   * The last state this hook observed, serialised.
   *
   * Autosave must not fire for the state the form opened with — otherwise
   * simply opening a form would write an empty draft, and (worse) opening it
   * while a draft was on offer would overwrite that draft with the blank
   * initial values before the user could restore it. `null` means "the next
   * value I see is the initial one", which is also how `restore()` and
   * `clear()` re-arm the hook.
   */
  const lastSerialised = useRef<string | null>(null)

  // ── Look for a draft when the form opens ─────────────────────────────────
  useEffect(() => {
    if (!sessionKey) return
    let cancelled = false
    lastSerialised.current = null
    pruneForeignDrafts(scope)
    void readDraft<T>(scope, formKey).then(envelope => {
      if (cancelled) return
      setSession({
        key: sessionKey,
        recovered: envelope ? envelope.data : null,
        recoveredAt: envelope ? envelope.savedAt : null,
        savedAt: null,
      })
      setClock(Date.now())
    })
    return () => { cancelled = true }
  }, [sessionKey, scope, formKey])

  // ── Mirror edits to storage ──────────────────────────────────────────────
  useEffect(() => {
    if (!sessionKey) return
    const serialised = JSON.stringify(value ?? null)
    // First observation of this form's state is its initial value, not an edit.
    if (lastSerialised.current === null) { lastSerialised.current = serialised; return }
    if (serialised === lastSerialised.current) return
    lastSerialised.current = serialised

    const meaningful = isMeaningful ? isMeaningful(value) : isMeaningfulDraft(value)
    const timer = window.setTimeout(() => {
      const now = Date.now()
      if (meaningful) {
        void writeDraft(scope, formKey, value, now)
      } else {
        // Edited back down to empty: the draft is no longer worth keeping, and
        // leaving it would offer back a blank form on the next visit.
        void clearDraft(scope, formKey)
      }
      setSession(prev => (prev.key === sessionKey
        ? { ...prev, savedAt: meaningful ? now : null }
        : { key: sessionKey, ...EMPTY_SESSION, savedAt: meaningful ? now : null }))
      setClock(now)
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [sessionKey, scope, formKey, value, isMeaningful])

  // ── Keep the relative timestamps honest ──────────────────────────────────
  useEffect(() => {
    if (live.savedAt === null && live.recoveredAt === null) return
    const id = window.setInterval(() => setClock(Date.now()), CLOCK_TICK_MS)
    return () => window.clearInterval(id)
  }, [live.savedAt, live.recoveredAt])

  const forget = useCallback((keepStored: boolean) => {
    lastSerialised.current = null
    setSession({ key: sessionKey, ...EMPTY_SESSION })
    if (!keepStored && scope.employeeId && scope.workspaceId) {
      void clearDraft(scope, formKey)
    }
  }, [sessionKey, scope, formKey])

  const restore = useCallback(() => {
    const data = sessionKey !== null && session.key === sessionKey ? session.recovered : null
    // The restored content becomes the editing session's state; treat the next
    // real change as the first edit rather than re-saving it immediately.
    forget(true)
    return data
  }, [sessionKey, session, forget])

  const dismiss = useCallback(() => forget(true), [forget])
  const discard = useCallback(() => forget(false), [forget])
  const clear = useCallback(() => forget(false), [forget])

  return {
    recovered: live.recovered,
    recoveredAtLabel: live.recoveredAt === null ? null : formatLastSaved(live.recoveredAt, clock),
    savedAtLabel: live.savedAt === null ? null : formatLastSaved(live.savedAt, clock),
    restore,
    dismiss,
    discard,
    clear,
  }
}
