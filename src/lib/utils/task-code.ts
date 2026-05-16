/**
 * Task numbering / code utilities.
 *
 * Each task has a sequential `task_number` column (1, 2, 3...) which is
 * shown as `#1`, `#2` etc. across the app. The first task ever created is #1.
 *
 * Existing code may pass a task object (with `task_number`), a raw number,
 * or null/undefined. Returns `#?` for missing numbers.
 */

type TaskLike = { task_number?: number | null }

export function taskCode(input: TaskLike | number | null | undefined): string {
  if (input == null) return '#?'
  if (typeof input === 'number') return `#${input}`
  if (typeof input === 'object' && input.task_number != null) return `#${input.task_number}`
  return '#?'
}

/**
 * True if `query` matches the task's number.
 * Supports `#42`, `42`, partial substring match.
 */
export function taskCodeMatches(input: TaskLike | number | null | undefined, query: string): boolean {
  if (input == null || !query) return false
  const num =
    typeof input === 'number' ? input :
    typeof input === 'object' ? input.task_number : null
  if (num == null) return false
  const q = query.trim().replace(/^#/, '').replace(/\s/g, '')
  if (!q) return false
  return String(num).includes(q)
}

/**
 * Compute the next task_number given the max used so far.
 * Pass the result of a `MAX(task_number)` query (which may return null).
 */
export function nextTaskNumber(maxUsed: number | null | undefined): number {
  return (maxUsed ?? 0) + 1
}
