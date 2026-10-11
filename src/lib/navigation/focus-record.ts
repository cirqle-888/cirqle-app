/**
 * Deep-linking to one record on a filtered list screen.
 *
 * Cirqle's list screens are windowed by design: Tasks loads a rolling history
 * window, Cashbook caps its fetch, and every screen then narrows further with
 * the user's own month/status/client filters. That is what keeps them fast.
 * The cost is that a link to a specific record — "the payment for INV-204",
 * "task #42 from the request" — lands on a screen that quietly shows nothing,
 * because the focus handler looks for a row that was never rendered:
 *
 *     const el = document.querySelector(`[data-entry-id="${focusId}"]`)
 *     if (!el) return          // ← silent dead end
 *
 * There are two different failures hiding behind that one `return`, and they
 * need different answers:
 *
 *   · the record WAS loaded but the active filters exclude it — the screen
 *     should say so and offer to clear them, because the data is right there;
 *   · the record was never loaded — the screen should say that it could not
 *     open it, rather than looking broken.
 *
 * Telling those apart is all this module does. Fetching a single out-of-window
 * record stays with the server component that owns the permission and scope
 * pipeline for that table: widening a window must never mean widening access,
 * so a record is resolved through the same strip/visibility/unit filters as
 * every other row and simply appended to the set the client already renders.
 *
 * Pure and dependency-free.
 */

export type FocusOutcome<T> =
  /** No deep link on this request. */
  | { kind: 'none' }
  /** The record is on screen; scroll to it. */
  | { kind: 'visible'; record: T }
  /** Loaded, but the active filters hide it; offer to clear them. */
  | { kind: 'hidden'; record: T }
  /** Not in the loaded set at all, or not one this viewer may see. */
  | { kind: 'missing' }

/**
 * Where does the deep-linked record stand?
 *
 * `all` is everything the server sent for this screen; `visible` is what the
 * active filters leave. Both are searched by the same id accessor, so a caller
 * cannot accidentally compare an id from one shape against another.
 */
export function resolveFocus<T>(
  focusId: string | null | undefined,
  all: readonly T[],
  visible: readonly T[],
  idOf: (record: T) => string | null | undefined,
): FocusOutcome<T> {
  const id = focusId?.trim()
  if (!id) return { kind: 'none' }

  const record = all.find(r => idOf(r) === id)
  if (!record) return { kind: 'missing' }

  // Identity, not id, so a screen whose filters produce new objects per render
  // still resolves — `visible` is always derived from `all` on these screens.
  return visible.some(r => idOf(r) === id)
    ? { kind: 'visible', record }
    : { kind: 'hidden', record }
}

/**
 * Does this task match a human-written reference?
 *
 * Deep links to a task arrive in three spellings depending on who wrote them —
 * the uuid from a database row, "#42" from a chip someone copied, or "42" from
 * a typed search. Accepting all three is cheaper than normalising every
 * producer, and a task number is only ever compared against a task number.
 */
export function matchesTaskRef(
  task: { id?: string | null; task_number?: number | string | null },
  ref: string | null | undefined,
): boolean {
  const want = ref?.trim().replace(/^#/, '')
  if (!want) return false
  if (task.id && task.id === ref?.trim()) return true
  if (task.task_number === null || task.task_number === undefined) return false
  // Numeric compare, so "042" and 42 agree and "4x" never matches 4.
  if (!/^\d+$/.test(want)) return false
  return Number(task.task_number) === Number(want)
}

/**
 * Human label for the "this record is hidden by your filters" notice.
 *
 * Deliberately carries no money: these notices render on screens where the
 * amount columns may be stripped for the viewer, and a reference plus a date
 * is enough to recognise the row you asked for.
 */
export function focusNoticeLabel(parts: {
  reference?: string | null
  date?: string | null
}): string {
  const bits = [parts.reference?.trim(), parts.date?.trim()].filter(Boolean)
  return bits.length ? bits.join(' · ') : 'The selected record'
}
