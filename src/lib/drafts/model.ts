/**
 * Recoverable form drafts — the pure model.
 *
 * A draft is *unsent* form state: what someone had typed into a new task,
 * request or quotation when the tab was closed, the phone slept, or the
 * browser reloaded. It is not a queued mutation. The offline queue
 * (`@/lib/offline`) already covers "they pressed Submit and the network was
 * gone"; this covers "they never got to press Submit", which is the case that
 * currently loses work silently.
 *
 * ── SCOPE IS PART OF THE DATA, NOT JUST THE KEY ───────────────────────────
 *
 * A draft may hold business content — line items, amounts, a client's brief.
 * The storage it lives in (localStorage, or Capacitor Preferences on native)
 * is per-device and shared by whoever signs in on that device, so the key
 * carries the employee and workspace AND the stored envelope repeats them.
 * `decodeDraft` refuses an envelope whose scope does not match the caller's,
 * so a draft can never resurface for a different account or a different
 * workspace even if a key were reused or storage were copied between
 * profiles. That is the plan's "scope drafts to employee and workspace; clear
 * them on successful submission and account changes" — enforced by the reader
 * rather than by remembering to clean up on sign-out.
 *
 * ── DRAFTS NEVER SHORTEN THE SUBMIT PATH ──────────────────────────────────
 *
 * Restoring a draft only refills the form. Submission still goes through the
 * same server action and the same server-side validation it always did, which
 * matters for anything financial: a draft is typing that survived, not an
 * approval that happened.
 *
 * Pure and dependency-free, so it can be tested without a browser, a database
 * or a React tree. The storage binding and the React hook live alongside in
 * `store.ts` and `use-form-draft.ts`.
 */

/** Bumped only on an incompatible envelope change; older drafts are then ignored. */
export const DRAFT_VERSION = 1

export const DRAFT_KEY_PREFIX = `cirqle:draft:v${DRAFT_VERSION}`

/**
 * How long an unsent draft is worth offering back.
 *
 * Two weeks: long enough to survive a holiday, short enough that a stale
 * half-typed invoice does not ambush someone a quarter later. Expired drafts
 * are ignored on read and pruned on the next sweep.
 */
export const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000

export interface DraftScope {
  /** `employees.id` of the signed-in user. */
  employeeId: string
  /** Active workspace id — the same scope the rest of the UI switches on. */
  workspaceId: string
}

export interface DraftEnvelope<T> {
  v: number
  employeeId: string
  workspaceId: string
  formKey: string
  /** Epoch ms of the last write — what "Draft saved 2 minutes ago" reads. */
  savedAt: number
  data: T
}

/** Storage key for one form's draft within one scope. */
export function draftKey(scope: DraftScope, formKey: string): string {
  return `${DRAFT_KEY_PREFIX}:${scope.employeeId}:${scope.workspaceId}:${formKey}`
}

/** Does this storage key hold a draft at all? */
export function isDraftKey(key: string): boolean {
  return key.startsWith(`${DRAFT_KEY_PREFIX}:`)
}

/**
 * Is this draft key outside the given scope?
 *
 * Used to sweep another account's or another workspace's drafts off a shared
 * device — the reader already refuses them, this just stops them accumulating.
 */
export function isForeignDraftKey(key: string, scope: DraftScope): boolean {
  if (!isDraftKey(key)) return false
  return !key.startsWith(`${draftKeyScopePrefix(scope)}`)
}

function draftKeyScopePrefix(scope: DraftScope): string {
  return `${DRAFT_KEY_PREFIX}:${scope.employeeId}:${scope.workspaceId}:`
}

export function encodeDraft<T>(scope: DraftScope, formKey: string, data: T, now: number): string {
  const envelope: DraftEnvelope<T> = {
    v: DRAFT_VERSION,
    employeeId: scope.employeeId,
    workspaceId: scope.workspaceId,
    formKey,
    savedAt: now,
    data,
  }
  return JSON.stringify(envelope)
}

/**
 * Read a stored draft, or `null` if it must not be offered.
 *
 * Refuses, in order: unparseable JSON, a version this build does not
 * understand, the wrong form, the wrong employee or workspace, and anything
 * past its TTL. Every one of those is a silent `null` rather than a throw —
 * a corrupt draft must never be able to break the form it belongs to.
 */
export function decodeDraft<T>(
  raw: string | null,
  scope: DraftScope,
  formKey: string,
  now: number,
): DraftEnvelope<T> | null {
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null

  const e = parsed as Partial<DraftEnvelope<T>>
  if (e.v !== DRAFT_VERSION) return null
  if (e.formKey !== formKey) return null
  if (e.employeeId !== scope.employeeId) return null
  if (e.workspaceId !== scope.workspaceId) return null
  if (typeof e.savedAt !== 'number' || !Number.isFinite(e.savedAt)) return null
  // A savedAt in the future means a clock change, not a fresh draft; treat it
  // as current rather than expiring it, since the content is real either way.
  if (now - e.savedAt > DRAFT_TTL_MS) return null
  if (e.data === undefined) return null

  return { ...e, data: e.data } as DraftEnvelope<T>
}

/**
 * Is there anything in here worth offering back?
 *
 * Forms initialise with empty strings, zeroes and a default currency, so
 * writing every keystroke would otherwise leave a "recover your draft?" prompt
 * on a form nobody has touched. Empty strings, nulls, empty arrays and empty
 * objects do not count; a `false`, a `0` or any filled-in value does.
 *
 * Callers with a sharper notion of empty (a quotation whose only content is
 * one blank line row) pass their own predicate to the hook.
 */
export function isMeaningfulDraft(data: unknown): boolean {
  if (data === null || data === undefined) return false
  if (typeof data === 'string') return data.trim().length > 0
  if (typeof data === 'number') return true
  if (typeof data === 'boolean') return true
  if (Array.isArray(data)) return data.some(isMeaningfulDraft)
  if (typeof data === 'object') return Object.values(data as Record<string, unknown>).some(isMeaningfulDraft)
  return false
}

/**
 * "Draft saved …" — relative while it is recent, absolute once it is not.
 *
 * The plan asks for the last-save time to be displayed. Relative is what
 * someone wants while they are still working ("12 seconds ago" tells them
 * autosave is alive); an absolute date is what they want when recovering
 * something from Tuesday.
 */
export function formatLastSaved(savedAt: number, now: number): string {
  const secs = Math.round((now - savedAt) / 1000)
  if (secs < 5) return 'just now'
  if (secs < 60) return `${secs} seconds ago`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return new Date(savedAt).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}
