/**
 * One vocabulary for "is this form saving, saved, or broken?".
 *
 * Every form in Cirqle invented its own. Quotations keeps a `saving` boolean
 * and swaps its button to "Creating…"; Tasks keeps `saving` plus a separate
 * `addError` string rendered in its own red box; the bulk modals disable
 * Apply and say "Saving…"; some forms show nothing at all between the click
 * and the result. The states are the same four everywhere, so the copy,
 * the disabled rule and the error placement should be too — which is what the
 * improvement plan asks for across Tasks, Invoices, Cashbook and Quotations.
 *
 * This module is the vocabulary; `components/ui/form-status.tsx` renders it.
 * Both are additive: a form adopts them by replacing its own booleans, and
 * the ones that have not yet been converted keep working exactly as they are.
 *
 * Pure and dependency-free.
 */

export type SubmitState =
  | { status: 'idle' }
  | { status: 'saving' }
  /** Succeeded. `at` is epoch ms, for "Saved just now". */
  | { status: 'saved'; at: number }
  | { status: 'error'; message: string }

export const IDLE: SubmitState = { status: 'idle' }
export const SAVING: SubmitState = { status: 'saving' }

export function saved(at: number = Date.now()): SubmitState {
  return { status: 'saved', at }
}

/**
 * An error state from whatever the server returned.
 *
 * A missing or empty message becomes a sentence the reader can act on, rather
 * than an empty red box — which is what `res.error` being undefined produced
 * in several of these forms.
 */
export function failed(message?: string | null): SubmitState {
  const text = (message ?? '').trim()
  return { status: 'error', message: text || 'Something went wrong. Try again.' }
}

/** May the submit button be pressed? */
export function canSubmit(state: SubmitState, otherwiseReady = true): boolean {
  return state.status !== 'saving' && otherwiseReady
}

/**
 * The submit button's label for the current state.
 *
 * `saved` deliberately keeps the idle label: a button that says "Saved" is a
 * button people press again to check. The confirmation belongs beside the
 * button, not on it.
 */
export function submitLabel(
  state: SubmitState,
  labels: { idle: string; saving?: string },
): string {
  if (state.status === 'saving') return labels.saving ?? `${labels.idle}…`
  return labels.idle
}

// ── Required fields ────────────────────────────────────────────────────────

export interface RequiredField {
  /** Key into the form values. */
  key: string
  /** How the field is labelled on screen — the message quotes this. */
  label: string
}

/**
 * Is this value filled in?
 *
 * `false` and `0` count as filled: a "billable" checkbox set to false and a
 * quantity of zero are both answers. Only an empty string, a blank string,
 * null, undefined and an empty list are missing.
 */
function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

/** Which required fields are still empty, in the order they were declared. */
export function missingRequired(
  values: Record<string, unknown>,
  fields: readonly RequiredField[],
): RequiredField[] {
  return fields.filter(f => !isFilled(values[f.key]))
}

/**
 * The message for a set of missing fields.
 *
 * Names them, in the words on their own labels, instead of "Please fill all
 * required fields" — which leaves the reader hunting a long form for the one
 * box they missed. Returns `null` when nothing is missing, so a caller can
 * use it directly as the error state.
 */
export function requiredFieldMessage(missing: readonly RequiredField[]): string | null {
  if (missing.length === 0) return null
  const names = missing.map(f => f.label)
  if (names.length === 1) return `${names[0]} is needed before this can be saved.`
  const last = names[names.length - 1]
  return `${names.slice(0, -1).join(', ')} and ${last} are needed before this can be saved.`
}
