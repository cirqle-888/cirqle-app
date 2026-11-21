/**
 * Requests board: what dragging a card into another status column does.
 *
 * Pure, so the rules are unit-tested and the board stays a thin caller. The
 * rules (decided 2026-11-21):
 *
 * - Managers only (requests.manage); the board checks that before calling.
 * - Once a request has a task, the TASK owns the status: a drag moves the task,
 *   and the request follows through the existing task→request sync. A drag
 *   never writes the request's status behind its task's back.
 * - Finished work is not reopened by dragging (Completed, Rejected/Cancelled,
 *   Archived). Reopen stays a deliberate button in the request panel.
 * - Nothing goes back to New.
 * - Starting work needs someone to do it: a card with no assignee cannot be
 *   dragged into On Going. With an assignee it opens the usual prefilled
 *   Start task form, so a task is never created half-empty.
 * - Rejecting or cancelling asks first.
 */
import type { RequestStatus } from './core'

export type BoardColumn = 'new' | 'ongoing' | 'review' | 'completed' | 'rejected' | 'archived'

/** Task statuses a board drag may set. Invoiced and paid only come from invoicing. */
export type BoardTaskStatus = 'in_progress' | 'delivered' | 'done' | 'cancelled'

export const COLUMN_STATUSES: Record<BoardColumn, RequestStatus[]> = {
  new:       ['submitted', 'under_review', 'approved'],
  ongoing:   ['started', 'in_progress', 'waiting_for_content', 'revision_requested'],
  review:    ['delivered'],
  completed: ['completed'],
  rejected:  ['rejected', 'cancelled'],
  archived:  ['archived'],
}

export function columnOf(status: string): BoardColumn | null {
  for (const [col, statuses] of Object.entries(COLUMN_STATUSES) as [BoardColumn, string[]][]) {
    if (statuses.includes(status)) return col
  }
  return null
}

export interface BoardCard {
  status: string
  /** The request has been promoted to a task. */
  hasTask: boolean
  hasAssignee: boolean
}

export type BoardMove =
  | { kind: 'none' }
  | { kind: 'blocked'; reason: string }
  /** Open the prefilled Start task form for this request. */
  | { kind: 'start-task' }
  | { kind: 'request-status'; to: RequestStatus; confirm: string | null }
  | { kind: 'task-status'; to: BoardTaskStatus; confirm: string | null }

const TASK_STATUS_FOR: Partial<Record<BoardColumn, BoardTaskStatus>> = {
  ongoing: 'in_progress',
  review: 'delivered',
  completed: 'done',
  rejected: 'cancelled',
}

export function planBoardMove(card: BoardCard, target: BoardColumn): BoardMove {
  const from = columnOf(card.status)
  if (from === target) return { kind: 'none' }

  if (from === 'completed') return { kind: 'blocked', reason: 'Completed work is not reopened by dragging. Open the request and press Reopen.' }
  if (from === 'rejected' || from === 'archived' || from === null) {
    return { kind: 'blocked', reason: 'A closed request is not moved by dragging. Open it to change it.' }
  }
  if (target === 'new') return { kind: 'blocked', reason: 'A request cannot go back to New.' }
  if (target === 'archived') return { kind: 'blocked', reason: "Archive from the request's ⋯ menu." }

  if (card.hasTask) {
    const to = TASK_STATUS_FOR[target]!
    return {
      kind: 'task-status', to,
      confirm: to === 'cancelled' ? 'Cancel the linked task? The request will be cancelled with it.' : null,
    }
  }

  if (from === 'new') {
    if (target === 'ongoing') {
      return card.hasAssignee
        ? { kind: 'start-task' }
        : { kind: 'blocked', reason: 'Assign someone first. A request with nobody on it cannot be started.' }
    }
    if (target === 'rejected') return { kind: 'request-status', to: 'rejected', confirm: 'Reject this request?' }
    return { kind: 'blocked', reason: 'Start the task first. This request has no task yet.' }
  }

  // Started without a task (older requests), or under review.
  if (target === 'review') return { kind: 'request-status', to: 'delivered', confirm: null }
  if (target === 'completed') return { kind: 'request-status', to: 'completed', confirm: null }
  if (target === 'rejected') return { kind: 'request-status', to: 'cancelled', confirm: 'Cancel this request?' }
  // review → ongoing with no task: there is no manual path back.
  return { kind: 'blocked', reason: 'Ask for a revision from the request panel instead.' }
}
