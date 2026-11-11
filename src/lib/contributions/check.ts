/**
 * Contribution checks — a filtered list of jobs sent to one person to confirm
 * their credit. Pure rules only; the reads and writes live in
 * app/(dashboard)/dashboard/contributions/check/actions.ts.
 *
 * Answering never touches pay data: "I worked on this" is a flag for the
 * sender, who then fixes the split on the Contributions page.
 */

export type CheckAnswer = 'correct' | 'worked'
export type CheckStatus = 'open' | 'answered' | 'closed'

/** Big enough for a month of one person's work, small enough to answer. */
export const MAX_CHECK_JOBS = 300

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Unique, well-formed task ids in the order given, capped at MAX_CHECK_JOBS. */
export function normalizeCheckTaskIds(ids: readonly string[], max = MAX_CHECK_JOBS): { ids: string[]; dropped: number } {
  const seen = new Set<string>()
  for (const id of ids) {
    if (typeof id === 'string' && UUID.test(id)) seen.add(id.toLowerCase())
  }
  const all = [...seen]
  return { ids: all.slice(0, max), dropped: Math.max(0, all.length - max) }
}

export interface CheckItemLike { answer: CheckAnswer | null }

export interface CheckSummary {
  total: number
  answered: number
  correct: number
  worked: number
  pending: number
}

export function summarizeCheck(items: readonly CheckItemLike[]): CheckSummary {
  let correct = 0, worked = 0
  for (const it of items) {
    if (it.answer === 'correct') correct++
    else if (it.answer === 'worked') worked++
  }
  const answered = correct + worked
  return { total: items.length, answered, correct, worked, pending: items.length - answered }
}

/**
 * What the viewer can do with a check:
 *   answer — it was sent to them, and it is still open
 *   review — they sent it, or they are an admin
 *   read   — it was sent to them, and it is no longer open
 */
export function checkAccess(
  viewer: { employeeId: string | null; isAdmin: boolean },
  check: { employee_id: string; requested_by: string; status: CheckStatus },
): 'answer' | 'review' | 'read' | null {
  if (viewer.employeeId && viewer.employeeId === check.employee_id) {
    return check.status === 'open' ? 'answer' : 'read'
  }
  if (viewer.isAdmin || (viewer.employeeId && viewer.employeeId === check.requested_by)) return 'review'
  return null
}

/** One line for the sender's notification once the answers are in. */
export function answersMessage(s: CheckSummary): string {
  if (s.worked === 0) return `All ${s.total} job${s.total === 1 ? '' : 's'} marked correct.`
  return `${s.worked} job${s.worked === 1 ? '' : 's'} need${s.worked === 1 ? 's' : ''} a look, ${s.correct} marked correct.`
}

export const MAX_CHECK_NOTE = 1000
export const MAX_CHECK_COMMENT = 500

export function cleanText(v: string | null | undefined, max: number): string | null {
  const t = (v ?? '').trim()
  return t ? t.slice(0, max) : null
}
