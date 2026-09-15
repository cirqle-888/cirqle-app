import { round2 } from '@/lib/calculations/currency'
import type { DateWindow } from './view'

/**
 * Team earnings, aggregated — the other half of the dashboard's heavy reads.
 *
 * `contribution_scores` for 36 months is the single largest query the
 * dashboard makes: 5,470 rows and 1.5 MB on the wire, every load, growing with
 * every month traded. The admin panel that consumes it needs four numbers per
 * employee — earnings, tasks, creatives credited — for a date window. Those
 * survive aggregation completely.
 *
 * TWO RULES THIS FILE EXISTS TO HOLD:
 *
 * 1. DEDUPLICATE BEFORE AGGREGATING. A task can be scored more than once
 *    (a recalculation writes a fresh row), and the server returns them newest
 *    first. Summing raw rows double-counts every recalculated task — and
 *    unlike the row-by-row path, an aggregate gives nobody a chance to notice.
 *    `dedupeScores` runs first, keeping the newest row per (employee, task).
 *
 * 2. NEVER `calculated_at` AS A DATE. It records when the arithmetic ran, not
 *    when the work happened; a recalculation in September would move March's
 *    earnings into September. A row whose task has no `task_date` is DROPPED,
 *    exactly as the row-by-row path drops it.
 *
 * WHAT IT HOLDS: employee ids, never names. The privacy gate
 * (`npm run lint:privacy`) fails the build on a rendered employee name, and
 * the safest way to pass it is to have no name in the shape at all.
 */

/** One score row, as the dashboard query returns it. */
export interface ScoreRow {
  employee_id: string
  score_percentage: number | null
  earnings_inr: number | null
  task: { id: string; quantity: number | null; task_date: string | null } | null
}

/** One employee's totals for one bucket (a month, or a day). */
export interface EmployeeTotal {
  employeeId: string
  /** 'YYYY-MM' in `months`, 'YYYY-MM-DD' in `days`. */
  bucket: string
  earningsInr: number
  taskCount: number
  /** Σ quantity × score% ÷ 100 — creatives CREDITED, not tasks touched. */
  creatives: number
}

/**
 * The cached shape.
 *
 * Months cover all history and answer every whole-month filter exactly.
 * `days` covers only the recent tail, because the only filters that cut a
 * month in half — today, yesterday, last 7, last 30, a single day — all land
 * there. An arbitrary custom range reaching further back is the one case that
 * cannot be exact, and `sliceEarnings` says so rather than guessing.
 */
export interface EarningsAggregate {
  months: EmployeeTotal[]
  days: EmployeeTotal[]
  /** The earliest date `days` covers. Older windows fall back to months. */
  daysFrom: string
}

/** Newest calculation per (employee, task). Input must be newest-first. */
export function dedupeScores(rows: readonly ScoreRow[]): ScoreRow[] {
  const seen = new Set<string>()
  const out: ScoreRow[] = []
  for (const s of rows) {
    const taskId = s.task?.id
    if (!taskId) continue
    const key = `${s.employee_id}|${taskId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

function bucketise(rows: readonly ScoreRow[], width: 7 | 10): EmployeeTotal[] {
  const map = new Map<string, EmployeeTotal>()
  for (const s of rows) {
    const date = s.task?.task_date
    if (!date || date.length < 10) continue
    const bucket = date.slice(0, width)
    const key = `${s.employee_id}|${bucket}`
    let e = map.get(key)
    if (!e) {
      e = { employeeId: s.employee_id, bucket, earningsInr: 0, taskCount: 0, creatives: 0 }
      map.set(key, e)
    }
    e.earningsInr += s.earnings_inr || 0
    e.taskCount += 1
    e.creatives += Number(s.task?.quantity ?? 1) * ((s.score_percentage ?? 0) / 100)
  }
  for (const e of map.values()) {
    e.earningsInr = round2(e.earningsInr)
    // Credited creatives are fractional by nature (a 30% share of one poster),
    // so they keep three decimals rather than being rounded to money.
    e.creatives = Math.round(e.creatives * 1000) / 1000
  }
  return [...map.values()].sort((a, b) =>
    a.bucket === b.bucket ? a.employeeId.localeCompare(b.employeeId) : a.bucket.localeCompare(b.bucket))
}

/**
 * Aggregate raw score rows. Deduplicates first — see rule 1 above.
 *
 * `daysFrom` decides how far back per-day detail is kept. Everything older is
 * represented by its month alone.
 */
export function aggregateEarnings(rows: readonly ScoreRow[], daysFrom: string): EarningsAggregate {
  const deduped = dedupeScores(rows)
  return {
    months: bucketise(deduped, 7),
    days: bucketise(deduped.filter(s => (s.task?.task_date ?? '') >= daysFrom), 10),
    daysFrom,
  }
}

/** Join cached history to the live current month. Live wins on any overlap. */
export function mergeEarnings(
  historical: EarningsAggregate,
  liveRows: readonly ScoreRow[],
): EarningsAggregate {
  const live = aggregateEarnings(liveRows, '0000-00-00')
  const liveMonths = new Set(live.months.map(m => m.bucket))
  const liveDays = new Set(live.days.map(d => d.bucket))
  return {
    months: [...historical.months.filter(m => !liveMonths.has(m.bucket)), ...live.months]
      .sort((a, b) => a.bucket.localeCompare(b.bucket)),
    days: [...historical.days.filter(d => !liveDays.has(d.bucket)), ...live.days]
      .sort((a, b) => a.bucket.localeCompare(b.bucket)),
    // The live month always carries day detail, so the tail starts no later
    // than its first day.
    daysFrom: [historical.daysFrom, ...live.days.map(d => d.bucket)].sort()[0] ?? historical.daysFrom,
  }
}

export interface EarningsSlice {
  /** employeeId → totals for the window. */
  byEmployee: Map<string, { earningsInr: number; taskCount: number; creatives: number }>
  /**
   * False when the window cuts a month that has no day detail left — a custom
   * range reaching past `daysFrom`. The figures are then that month's WHOLE
   * total, which overstates a partial window. Shown, never hidden.
   */
  exact: boolean
}

const monthOf = (date: string) => date.slice(0, 7)

/** Totals per employee for a window, or for all history when `window` is null. */
export function sliceEarnings(agg: EarningsAggregate, window: DateWindow | null): EarningsSlice {
  const byEmployee = new Map<string, { earningsInr: number; taskCount: number; creatives: number }>()
  const add = (id: string, t: EmployeeTotal) => {
    const e = byEmployee.get(id) ?? { earningsInr: 0, taskCount: 0, creatives: 0 }
    e.earningsInr = round2(e.earningsInr + t.earningsInr)
    e.taskCount += t.taskCount
    e.creatives = Math.round((e.creatives + t.creatives) * 1000) / 1000
    byEmployee.set(id, e)
  }

  if (!window) {
    for (const m of agg.months) add(m.employeeId, m)
    return { byEmployee, exact: true }
  }

  let exact = true
  const fromMonth = monthOf(window.from)
  const toMonth = monthOf(window.to)

  for (const m of agg.months) {
    if (m.bucket < fromMonth || m.bucket > toMonth) continue
    const wholeMonthCovered =
      (m.bucket > fromMonth || window.from <= `${m.bucket}-01`) &&
      (m.bucket < toMonth || window.to >= lastDayOf(m.bucket))
    if (wholeMonthCovered) { add(m.employeeId, m); continue }

    // A cut month: use day detail when it exists, and say so when it does not.
    if (m.bucket >= monthOf(agg.daysFrom)) continue   // handled by the day pass
    exact = false
    add(m.employeeId, m)
  }

  // Day pass, for the months the month pass deliberately skipped.
  const dayFloor = monthOf(agg.daysFrom)
  for (const d of agg.days) {
    if (d.bucket < window.from || d.bucket > window.to) continue
    const month = monthOf(d.bucket)
    if (month < dayFloor) continue
    const wholeMonthCovered =
      (month > fromMonth || window.from <= `${month}-01`) &&
      (month < toMonth || window.to >= lastDayOf(month))
    if (wholeMonthCovered) continue                   // already added as a month
    add(d.employeeId, d)
  }

  return { byEmployee, exact }
}

function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}
