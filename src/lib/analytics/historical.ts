import { isBillableTask } from '@/lib/tasks/billable'
// THE money rounder. A local Math.round(n*100)/100 disagrees at .xx5
// midpoints and drifts a paisa against every other engine — there is a guard
// test (calculations/round2.test.ts) that refuses to let one back in.
import { round2 } from '@/lib/calculations/currency'

/**
 * Monthly analytics aggregates — what the dashboard actually needs from 36
 * months of tasks, instead of 36 months of tasks.
 *
 * WHY THIS EXISTS: the dashboard fetched every task row of the last three
 * years on every load, and again on every `router.refresh()` a realtime event
 * triggered — about 256 KB of task rows and 293 KB of contribution scores,
 * per load, per person. Months 2 through 36 cannot change, so almost all of
 * that is the same bytes over and over. Worse, it GROWS: every month of
 * trading permanently enlarges the payload for a screen showing the same
 * thing. That is why egress kept climbing.
 *
 * The fix is not to fetch history more cleverly but to stop fetching history:
 * a closed month is a handful of numbers, and those numbers are all the
 * dashboard ever displays from it.
 *
 * NO MONEY RULE IS RE-IMPLEMENTED HERE. `isBillableTask` decides what counts
 * as revenue — the same helper the live path uses — so a waived task is worth
 * its price internally and nothing to a client ranking, exactly as before.
 *
 * PURE: rows in, aggregates out. No database, no cache, no Supabase. That is
 * what lets "cached equals uncached" be a test rather than a hope.
 */

/** The task columns the dashboard's analytics actually read. */
export interface AnalyticsTask {
  task_date: string | null
  billing_amount_inr: number | null
  /** Creatives produced. The production counter sums this, not rows. */
  quantity?: number | null
  is_billable?: boolean | null
  status?: string | null
  client?: { id: string; name: string } | null
  service_id?: string | null
  service?: { id: string; name: string } | null
}

/** Revenue and volume for one client (or service) inside one month. */
export interface EntityTotal {
  id: string
  name: string
  /** Billable revenue only — waived work brought nothing in. */
  revenue: number
  count: number
}

/**
 * One day's totals. No client or service split — that would multiply the
 * payload by every client who worked that day, and nothing reads it per day.
 *
 * Days exist because two consumers genuinely need daily resolution over
 * arbitrary ranges: the trend graph draws a wave, and the date filter offers
 * "last 7 days" and custom ranges. Month totals cannot answer either, and
 * falling back to raw rows for them would undo the saving.
 */
export interface DayTotal {
  /** 'YYYY-MM-DD'. */
  date: string
  /** Every task's value, waived included. */
  value: number
  count: number
  /** Creatives — the sum of quantity, not the row count. */
  quantity: number
}

export interface MonthAggregate {
  /** 'YYYY-MM'. The key everything else is derived from. */
  month: string
  /** Every task's value, waived included — this is work done, not money in. */
  taskValue: number
  taskCount: number
  /**
   * Billable value only. Kept beside `taskValue` rather than derived from the
   * per-client totals, because a task with no client still earns revenue and
   * would vanish from a sum over `byClient`.
   */
  revenue: number
  /** Sum of `quantity` — creatives produced, which is not the same as tasks. */
  creativeCount: number
  byClient: EntityTotal[]
  byService: EntityTotal[]
  /** Ascending by date. Only days that had work appear. */
  days: DayTotal[]
}

/** 'YYYY-MM' for a task date, or null when the date is unusable. */
export function monthKey(date: string | null | undefined): string | null {
  if (!date || date.length < 7) return null
  const key = date.slice(0, 7)
  return /^\d{4}-\d{2}$/.test(key) ? key : null
}

/**
 * Fold task rows into one aggregate per month.
 *
 * `taskValue` counts every task, because the trend chart measures work done.
 * `revenue` on the per-client and per-service totals counts only billable
 * work, because those drive rankings and a waived job must not lift a client
 * up one. That asymmetry is the live dashboard's, kept deliberately.
 */
export function aggregateByMonth(tasks: readonly AnalyticsTask[]): MonthAggregate[] {
  const months = new Map<string, {
    taskValue: number
    taskCount: number
    revenue: number
    creativeCount: number
    byClient: Map<string, EntityTotal>
    byService: Map<string, EntityTotal>
    days: Map<string, DayTotal>
  }>()

  for (const t of tasks) {
    const key = monthKey(t.task_date)
    if (!key) continue

    let m = months.get(key)
    if (!m) {
      m = {
        taskValue: 0, taskCount: 0, revenue: 0, creativeCount: 0,
        byClient: new Map(), byService: new Map(), days: new Map(),
      }
      months.set(key, m)
    }

    const value = Number(t.billing_amount_inr) || 0
    m.taskValue += value
    m.taskCount += 1

    // The same rule the live path applies, from the same helper.
    const revenue = isBillableTask(t as Parameters<typeof isBillableTask>[0]) ? value : 0
    m.revenue += revenue
    // A task defaults to one creative, matching the live counter's `?? 1`.
    const quantity = Number(t.quantity ?? 1) || 0
    m.creativeCount += quantity

    const day = String(t.task_date).slice(0, 10)
    const d = m.days.get(day) ?? { date: day, value: 0, count: 0, quantity: 0 }
    d.value += value
    d.count += 1
    d.quantity += quantity
    m.days.set(day, d)

    const cid = t.client?.id
    const cname = t.client?.name
    if (cid && cname) {
      const prev = m.byClient.get(cid) ?? { id: cid, name: cname, revenue: 0, count: 0 }
      prev.revenue += revenue
      prev.count += 1
      m.byClient.set(cid, prev)
    }

    const sid = t.service_id ?? t.service?.id
    const sname = t.service?.name
    if (sid && sname) {
      const prev = m.byService.get(sid) ?? { id: sid, name: sname, revenue: 0, count: 0 }
      prev.revenue += revenue
      prev.count += 1
      m.byService.set(sid, prev)
    }
  }

  return [...months.entries()]
    .map(([month, m]) => ({
      month,
      taskValue: round2(m.taskValue),
      taskCount: m.taskCount,
      revenue: round2(m.revenue),
      creativeCount: m.creativeCount,
      byClient: [...m.byClient.values()].sort((a, b) => b.revenue - a.revenue),
      byService: [...m.byService.values()].sort((a, b) => b.revenue - a.revenue),
      days: [...m.days.values()]
        .map(d => ({ ...d, value: round2(d.value) }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    }))
    .sort((a, b) => a.month.localeCompare(b.month))
}

/**
 * Merge aggregates from several months into one.
 *
 * How a quarter, a year or "all time" is answered without going back to the
 * rows. Client and service totals add across months, which is why they are
 * stored per month rather than pre-summed.
 */
export function mergeMonths(months: readonly MonthAggregate[]): Omit<MonthAggregate, 'month'> {
  const byClient = new Map<string, EntityTotal>()
  const byService = new Map<string, EntityTotal>()
  let taskValue = 0
  let taskCount = 0
  let revenue = 0
  let creativeCount = 0
  const days: DayTotal[] = []

  const fold = (into: Map<string, EntityTotal>, from: readonly EntityTotal[]) => {
    for (const e of from) {
      const prev = into.get(e.id) ?? { id: e.id, name: e.name, revenue: 0, count: 0 }
      prev.revenue += e.revenue
      prev.count += e.count
      // A renamed client keeps its newest spelling: later months win.
      prev.name = e.name
      into.set(e.id, prev)
    }
  }

  for (const m of months) {
    taskValue += m.taskValue
    taskCount += m.taskCount
    revenue += m.revenue
    creativeCount += m.creativeCount
    fold(byClient, m.byClient)
    fold(byService, m.byService)
    for (const d of m.days) days.push(d)
  }

  return {
    taskValue: round2(taskValue),
    taskCount,
    revenue: round2(revenue),
    creativeCount,
    byClient: [...byClient.values()].sort((a, b) => b.revenue - a.revenue),
    byService: [...byService.values()].sort((a, b) => b.revenue - a.revenue),
    days: days.sort((a, b) => a.date.localeCompare(b.date)),
  }
}

/**
 * The current month, in the same 'YYYY-MM' shape.
 *
 * Calendar dates in this app resolve in Asia/Kolkata (src/lib/utils/local-date),
 * and the caller passes the value from there rather than this module reaching
 * for a clock — a pure function that reads `new Date()` is a function whose
 * tests pass at 11pm and fail at 1am.
 */
export function isHistoricalMonth(month: string, currentMonth: string): boolean {
  return month < currentMonth
}
