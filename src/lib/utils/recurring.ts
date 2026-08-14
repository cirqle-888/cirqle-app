/**
 * Recurrence arithmetic on plain calendar dates.
 *
 * No "now" is involved — this answers "given the date X, what is the next
 * occurrence?" — so the answer must not depend on any timezone at all, the
 * business one included. Anchoring in UTC and reading back in UTC makes the
 * arithmetic a pure `YYYY-MM-DD → YYYY-MM-DD` function.
 *
 * The previous version parsed `X + 'T00:00:00'` (LOCAL midnight) and then
 * serialised through UTC, which round-tripped only because the server happened
 * to run at UTC. Anywhere east of Greenwich it returned the day BEFORE each
 * occurrence, so every recurring task and cashbook entry would have drifted a
 * day earlier on each generation.
 */

// Given a task with is_recurring=true, calculate the next occurrence date
export function getNextOccurrence(taskDate: string, interval: string): string {
  const d = new Date(taskDate + 'T00:00:00Z')
  switch (interval) {
    case 'daily':     d.setUTCDate(d.getUTCDate() + 1); break
    case 'weekly':    d.setUTCDate(d.getUTCDate() + 7); break
    case 'biweekly':  d.setUTCDate(d.getUTCDate() + 14); break
    case 'monthly':   d.setUTCMonth(d.getUTCMonth() + 1); break
  }
  return d.toISOString().slice(0, 10)
}

export function shouldGenerateNext(task: { recurring_end_date?: string | null }, nextDate: string): boolean {
  if (!task.recurring_end_date) return true
  return nextDate <= task.recurring_end_date
}
