/**
 * Undo and redo for the areas editor.
 *
 * Every tool in that editor changes a shape: a trace lands slightly wrong, a
 * brush stroke goes too far, a mask adds eight areas at once. Without undo the
 * only recovery is deleting the area and starting again, which is why people
 * place one area and stop.
 *
 * Whole-state snapshots rather than a command log. The state here is a handful
 * of polygons — tens of numbers — so a snapshot costs nothing, and a command
 * log would mean every new tool having to describe its own inverse. The thing
 * that actually matters is the COALESCING below: a brush drags, and one drag
 * must be one undo rather than four hundred.
 *
 * Pure and dependency-free.
 */

export interface History<T> {
  /** Oldest first; the last entry is the current state. */
  past: T[]
  present: T
  /** Newest first: `future[0]` is what one redo restores. */
  future: T[]
  /**
   * Tag of the entry currently on top, when it was pushed as coalescing.
   * A further push with the same tag replaces it instead of stacking.
   */
  tag?: string
}

/**
 * How many steps back the editor can go.
 *
 * Twenty: deep enough to escape a bad run of edits, shallow enough that the
 * snapshots cannot quietly grow into something worth worrying about.
 */
export const HISTORY_LIMIT = 20

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] }
}

/**
 * Record a new state.
 *
 * `tag` coalesces: consecutive pushes carrying the same tag collapse into one
 * undoable step. A brush stroke tags every sampled point with the stroke's id,
 * so dragging across the artwork is one entry rather than one per pointermove.
 * Pass no tag for a discrete action — adding an area, deleting one.
 */
export function pushHistory<T>(history: History<T>, present: T, tag?: string): History<T> {
  // Nothing changed — a pointermove that did not move far enough to alter a
  // coordinate should not consume an undo step.
  if (Object.is(history.present, present)) return history

  // Same tag as the entry on top: replace the present, leave the past alone.
  if (tag !== undefined && history.tag === tag) {
    return { ...history, present, future: [] }
  }

  const past = [...history.past, history.present]
  return {
    past: past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past,
    present,
    future: [],
    tag,
  }
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0
}

export function undo<T>(history: History<T>): History<T> {
  if (!canUndo(history)) return history
  const past = [...history.past]
  const present = past.pop() as T
  return { past, present, future: [history.present, ...history.future] }
}

export function redo<T>(history: History<T>): History<T> {
  if (!canRedo(history)) return history
  const [present, ...future] = history.future
  return { past: [...history.past, history.present], present, future }
}

/**
 * Replace the present without making it undoable.
 *
 * For state that arrived from outside the editor — a reload, a save that
 * returned a canonical shape. Clears the future, because a redo stack built on
 * a state that no longer exists would restore something that was never there.
 */
export function resetHistory<T>(present: T): History<T> {
  return initHistory(present)
}
