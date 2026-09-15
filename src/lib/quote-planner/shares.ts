/**
 * What each employee has actually earned a share of, per service.
 *
 * A quote has no tasks yet, so "who would earn what" has to start somewhere.
 * Starting from history means the first number a planner shows is a prediction
 * rather than a guess, and somebody who has never worked this service shows
 * nothing rather than an invented slice.
 *
 * `score_percentage` is the right input because the engine already normalised
 * it: it is each employee's share of that task's pool, 0–100, before their
 * performance rating. Averaging it across a service's tasks answers "when this
 * work happens, roughly how is it split".
 *
 * PURE. The rows come in as arguments; the page does the reading.
 */

export interface ScoreRow {
  task_id: string | null
  employee_id: string
  score_percentage: number | null
}

export interface TaskRow {
  id: string
  service_id: string | null
}

export interface HistoricalShare {
  employeeId: string
  /** Mean share across the tasks this employee appeared on, 0–100. */
  sharePct: number
  /** How many tasks it is averaged over — a share from one task is a rumour. */
  taskCount: number
}

export interface HistoricalSharesInput {
  scores: ScoreRow[]
  tasks: TaskRow[]
  serviceId: string
  /** Drop anyone seen on fewer than this many tasks. Default 1. */
  minTasks?: number
}

/**
 * Average share per employee for one service, largest first.
 *
 * The averages are then RESCALED to sum to 100. Without it a service usually
 * worked by two people would seed shares summing to ~100, but one worked by a
 * rotating pair would seed ~50 each and quietly under-assign the pool. The
 * planner presents these as "the split", so they have to be a whole split.
 */
export function historicalShares(input: HistoricalSharesInput): HistoricalShare[] {
  const { scores, tasks, serviceId, minTasks = 1 } = input

  const taskIds = new Set(tasks.filter(t => t.service_id === serviceId).map(t => t.id))
  if (taskIds.size === 0) return []

  const totals = new Map<string, { sum: number; n: number }>()
  for (const s of scores) {
    if (!s.task_id || !taskIds.has(s.task_id)) continue
    const value = Number(s.score_percentage)
    if (!Number.isFinite(value) || value <= 0) continue
    const prev = totals.get(s.employee_id) ?? { sum: 0, n: 0 }
    prev.sum += value
    prev.n += 1
    totals.set(s.employee_id, prev)
  }

  const means = [...totals.entries()]
    .filter(([, v]) => v.n >= minTasks)
    .map(([employeeId, v]) => ({ employeeId, mean: v.sum / v.n, taskCount: v.n }))

  const totalMean = means.reduce((s, m) => s + m.mean, 0)
  if (totalMean <= 0) return []

  return means
    .map(m => ({
      employeeId: m.employeeId,
      sharePct: Math.round((m.mean / totalMean) * 1000) / 10,
      taskCount: m.taskCount,
    }))
    .sort((a, b) => b.sharePct - a.sharePct)
}

/** Replace the historical seed with whatever the planner has since set. */
export function applyOverrides(
  base: HistoricalShare[],
  overrides: Record<string, number>,
): HistoricalShare[] {
  return base.map(b => (
    typeof overrides[b.employeeId] === 'number'
      ? { ...b, sharePct: overrides[b.employeeId] }
      : b
  ))
}
