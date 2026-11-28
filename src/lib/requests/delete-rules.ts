/**
 * When a request may be deleted for good.
 *
 * Delete is for clearing out what never became work: test entries, and
 * requests that were cancelled or rejected. Anything with a work record stays
 * (Archive is how it leaves the lists). Pure, so the server action, the
 * Requests screen and My Work all apply the same rule.
 */

/** How many one delete may take: each is checked and removed one at a time. */
export const DELETE_LIMIT = 100

export interface LinkedTaskFacts {
  status?: string | null
  /** Set = the task is in the Trash. */
  deleted_at?: string | null
}

/** A task that still stands: neither in the Trash nor cancelled. */
export function isLiveTask(task: LinkedTaskFacts | null | undefined): boolean {
  return !!task && !task.deleted_at && task.status !== 'cancelled'
}

/**
 * Why this request must be kept, or null when it may be deleted. The text
 * completes the sentence "Kept because …".
 */
export function requestDeleteBlocker(request: {
  status: string
  task?: LinkedTaskFacts | null
}): string | null {
  if (isLiveTask(request.task)) return 'it has a task (cancel or delete the task first)'
  if (request.status === 'completed' || request.status === 'delivered') {
    return 'it is finished work (archive it first if it really should go)'
  }
  return null
}

/** What someone is told before a delete runs. */
export function deleteRequestsWarning(ask: { count: number; title?: string | null; keeping?: number }): string {
  const one = ask.count === 1
  const what = !one ? `These ${ask.count} requests` : ask.title ? `“${ask.title}”` : 'This request'
  const parts = [
    `${what} and ${one ? 'its' : 'their'} history will be removed. This cannot be undone.`,
    one
      ? 'If it came from the social calendar, that entry is marked cancelled. The client’s tracking link will no longer show it.'
      : 'Social calendar entries they came from are marked cancelled. Client tracking links will no longer show them.',
  ]
  if (ask.keeping) {
    parts.push(`${ask.keeping} more you selected will be kept, because ${ask.keeping === 1 ? 'it has' : 'they have'} a task or finished work.`)
  }
  return parts.join(' ')
}
