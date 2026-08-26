/**
 * My Work — the four stages a designer actually thinks in.
 *
 * The request pipeline has eleven live statuses, which is the right vocabulary
 * for the inbox and the wrong one for someone who just wants to know what is
 * on their plate. These four collapse it: every status a designer can be
 * looking at maps into exactly one stage, and each stage has ONE status the
 * board writes when a card is dropped into it.
 *
 * Pure functions only — no imports — so this is shared by the server action
 * (which enforces the transition) and the board (which renders it) without
 * either being able to drift from the other.
 */

export type WorkStage = 'todo' | 'working' | 'delivered' | 'done'

export const WORK_STAGES: readonly WorkStage[] = ['todo', 'working', 'delivered', 'done']

export const STAGE_LABEL: Record<WorkStage, string> = {
  todo: 'To Do',
  working: 'Working On It',
  delivered: 'Sent for Review',
  done: 'Done',
}

/** What each stage means, in the designer's own terms. */
export const STAGE_HINT: Record<WorkStage, string> = {
  todo: 'Not started yet',
  working: 'You are working on this now',
  delivered: 'Handed over — waiting on the client',
  done: 'Finished and accepted',
}

export const STAGE_CHIP: Record<WorkStage, string> = {
  todo:      'bg-secondary text-muted-foreground border-border',
  working:   'bg-amber-500/15 text-amber-500 border-amber-500/25',
  delivered: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
  done:      'bg-green-500/15 text-green-500 border-green-500/25',
}

/**
 * The status written when a card is DROPPED into a stage.
 *
 * 'todo' is absent on purpose: there is no "un-start" status a designer may
 * write. Dragging backwards out of Working would have to pick between
 * submitted / under_review / approved — a triage decision that belongs to
 * whoever runs the inbox, not to the person doing the work. The board refuses
 * that drop rather than guessing.
 */
export const STAGE_TARGET_STATUS: Partial<Record<WorkStage, string>> = {
  working: 'in_progress',
  delivered: 'delivered',
  done: 'completed',
}

/** Which stage a request currently sits in. */
export function stageOf(status: string): WorkStage {
  if (status === 'completed') return 'done'
  if (status === 'delivered') return 'delivered'
  if (['started', 'in_progress', 'waiting_for_content', 'revision_requested'].includes(status)) return 'working'
  return 'todo'   // submitted / under_review / approved
}

/**
 * Which stage a CALENDAR PLAN ITEM sits in.
 *
 * A plan item has no request status of its own — it is either still just a
 * plan, or it has become a task. So the linked task's status is the answer
 * whenever there is one, and everything else is To Do. Mapping through the
 * same task vocabulary as stageOf keeps one plan and one request at the same
 * stage looking identical on the board, which is the point of showing them
 * together at all.
 */
export function stageOfPlan(taskStatus: string | null | undefined): WorkStage {
  if (!taskStatus) return 'todo'
  if (['done', 'invoiced', 'paid'].includes(taskStatus)) return 'done'
  if (taskStatus === 'delivered') return 'delivered'
  if (taskStatus === 'cancelled') return 'todo'   // trashed task → back to just a plan
  return 'working'
}

/**
 * Statuses a designer's board never shows. Cancelled and rejected work is not
 * theirs to resurrect, and archived work is gone — surfacing any of it would
 * put cards on the board that cannot be moved.
 */
export const HIDDEN_STATUSES = ['cancelled', 'rejected', 'archived'] as const

export function isHidden(status: string): boolean {
  return (HIDDEN_STATUSES as readonly string[]).includes(status)
}

/** Stages that still represent outstanding work — what "pending" counts. */
export function isPending(stage: WorkStage): boolean {
  return stage === 'todo' || stage === 'working'
}

/**
 * Is this a move the designer is allowed to make?
 *
 * Forward-only, plus one deliberate exception: Delivered → Working, for when
 * the client comes back with changes. Everything else backwards is refused —
 * a designer un-completing their own finished work would rewrite a record the
 * client has already been notified about.
 */
export function canMove(from: WorkStage, to: WorkStage): boolean {
  if (from === to) return false
  if (!STAGE_TARGET_STATUS[to]) return false          // nothing to write for 'todo'
  if (from === 'done') return false                   // finished is finished
  if (from === 'delivered' && to === 'working') return true   // revision came back
  return WORK_STAGES.indexOf(to) > WORK_STAGES.indexOf(from)
}

/** Why a refused move was refused — shown to the user, so it must be plain. */
export function moveRefusalReason(from: WorkStage, to: WorkStage): string {
  if (from === to) return ''
  if (to === 'todo') return 'Work cannot be moved back to To Do — ask a manager if this needs re-planning.'
  if (from === 'done') return 'This is already done. A manager can reopen it if something changed.'
  return `Move it to ${STAGE_LABEL[WORK_STAGES[WORK_STAGES.indexOf(from) + 1]]} first.`
}
