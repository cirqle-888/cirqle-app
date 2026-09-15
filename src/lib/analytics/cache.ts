import 'server-only'
import { unstable_cache } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll } from '@/lib/supabase/server'
import { aggregateByMonth, type AnalyticsTask, type MonthAggregate } from './historical'
import { aggregateEarnings, type EarningsAggregate, type ScoreRow } from './earnings'

/**
 * The historical half of the dashboard's analytics, cached.
 *
 * WHAT IS CACHED AND WHAT IS NOT:
 *   · the CURRENT month is never cached. It is the only part anyone acts on
 *     today, and a stale "this month" is the one staleness nobody would
 *     tolerate. The page queries it live, every time.
 *   · CLOSED months are cached as aggregates for 24 hours, and busted the
 *     moment something in one of them is written.
 *
 * WHY AGGREGATES AND NOT ROWS: three years of task rows measured 634.7 KB per
 * load against production and grows with every month of trading. The same
 * months as aggregates are a few KB and stop growing meaningfully. It also
 * makes the privacy question disappear — an aggregate keyed by month, client
 * and service has no employee in it to leak.
 *
 * WHY unstable_cache AND NOT A TABLE: this is a performance cache, not a
 * record. `profit_snapshots` already exists for the other thing — freezing a
 * month's money when the owner closes the books — and conflating the two
 * would put a cache in a table that other code trusts as a source of truth.
 * `unstable_cache` gives a real TTL and tag invalidation, and the pattern is
 * already in this codebase (see the company-settings cache in
 * (dashboard)/layout.tsx).
 */

/** Everything historical. Busted when a month cannot be identified. */
export const ANALYTICS_TAG = 'analytics-historical'

/** One month. Busted when a write lands in that month specifically. */
export function analyticsMonthTag(month: string): string {
  return `analytics-month-${month}`
}

/** 24 hours. The safety net under explicit invalidation, never the only line. */
export const ANALYTICS_TTL_SECONDS = 24 * 60 * 60

/** The task columns the aggregate needs — nothing else leaves the database. */
const TASK_COLUMNS =
  'task_date, billing_amount_inr, quantity, is_billable, status, client_id, service_id'

/**
 * Closed months between `fromMonth` and `beforeMonth`, both 'YYYY-MM'.
 * `beforeMonth` is EXCLUSIVE — it is the current month, which never caches.
 *
 * One cache entry per call signature. The tag list means a write anywhere in
 * the window busts it; per-month tags let a single month's correction do so
 * without discarding the other 35.
 */
export async function getHistoricalAnalytics(
  fromMonth: string,
  beforeMonth: string,
): Promise<MonthAggregate[]> {
  const months = monthsBetween(fromMonth, beforeMonth)
  if (!months.length) return []

  const load = unstable_cache(
    async () => loadHistoricalAggregates(fromMonth, beforeMonth),
    // Key parts: a different window is a different entry.
    ['analytics-historical', fromMonth, beforeMonth],
    {
      revalidate: ANALYTICS_TTL_SECONDS,
      tags: [ANALYTICS_TAG, ...months.map(analyticsMonthTag)],
    },
  )
  return load()
}

/**
 * The uncached read, exported so a test can prove the cached path returns
 * exactly what the live path would.
 */
export async function loadHistoricalAggregates(
  fromMonth: string,
  beforeMonth: string,
): Promise<MonthAggregate[]> {
  const admin = createAdminClient()

  // Client and service names come from their own small tables rather than an
  // embedded join: 64 clients and 33 services repeated across 2,000 task rows
  // is most of what made the original query large.
  const [tasksRes, clientsRes, servicesRes] = await Promise.all([
    fetchAll(admin
      .from('tasks')
      .select(TASK_COLUMNS)
      .not('status', 'eq', 'cancelled')
      .is('deleted_at', null)
      .gte('task_date', `${fromMonth}-01`)
      .lt('task_date', `${beforeMonth}-01`)
      .order('task_date', { ascending: true })
      .order('id', { ascending: true })),
    fetchAll(admin.from('clients').select('id, name')),
    fetchAll(admin.from('services').select('id, name')),
  ])

  type Named = { id: string; name: string }
  const clientById = new Map<string, Named>(
    ((clientsRes.data || []) as Named[]).map(c => [c.id, { id: c.id, name: c.name }]))
  const serviceById = new Map<string, Named>(
    ((servicesRes.data || []) as Named[]).map(s => [s.id, { id: s.id, name: s.name }]))

  type Row = {
    task_date: string | null; billing_amount_inr: number | null; quantity: number | null
    is_billable: boolean | null; status: string | null
    client_id: string | null; service_id: string | null
  }
  const tasks: AnalyticsTask[] = ((tasksRes.data || []) as Row[]).map(t => ({
    task_date: t.task_date,
    billing_amount_inr: t.billing_amount_inr,
    quantity: t.quantity,
    is_billable: t.is_billable,
    status: t.status,
    client: t.client_id ? clientById.get(t.client_id) ?? null : null,
    service_id: t.service_id,
    service: t.service_id ? serviceById.get(t.service_id) ?? null : null,
  }))

  return aggregateByMonth(tasks)
}

/**
 * Every 'YYYY-MM' from `from` up to but excluding `before`.
 *
 * Bounded at 120 so a malformed input cannot spin: three years is 36, and a
 * window larger than a decade is a bug rather than a request.
 */
export function monthsBetween(from: string, before: string): string[] {
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(before)) return []
  const out: string[] = []
  let [y, m] = from.split('-').map(Number)
  for (let i = 0; i < 120; i++) {
    const key = `${y}-${String(m).padStart(2, '0')}`
    if (key >= before) break
    out.push(key)
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}

/* ── Team earnings ────────────────────────────────────────────────────────── */

/**
 * The historical half of team earnings, cached.
 *
 * ADMIN ONLY, AND THE REASON MATTERS: `unstable_cache` is a SHARED server
 * cache. Its key has no user in it, so anything stored here is visible to
 * every caller that computes the same key. The dashboard's scores query is
 * permission-branched — an admin reads every employee's rows, an employee
 * reads only their own — and caching the employee branch under a shared key is
 * precisely how one employee's earnings would be served to another.
 *
 * So only the admin branch caches. The employee branch stays live and
 * `employee_id`-scoped, which is both correct and already small: one person's
 * rows, not the whole studio's.
 *
 * It shares the month tags with the task aggregates above, so a write in a
 * closed month clears both — a corrected task and its recalculated scores are
 * one event, and clearing half of it would leave the two disagreeing.
 */
export async function getHistoricalEarnings(
  fromMonth: string,
  beforeMonth: string,
  daysFrom: string,
): Promise<EarningsAggregate> {
  const months = monthsBetween(fromMonth, beforeMonth)
  const empty: EarningsAggregate = { months: [], days: [], daysFrom }
  if (!months.length) return empty

  const load = unstable_cache(
    async () => loadHistoricalEarnings(fromMonth, beforeMonth, daysFrom),
    ['analytics-earnings', fromMonth, beforeMonth, daysFrom],
    {
      revalidate: ANALYTICS_TTL_SECONDS,
      tags: [ANALYTICS_TAG, ...months.map(analyticsMonthTag)],
    },
  )
  return load()
}

/** The uncached read, exported so a test can prove parity with the live path. */
export async function loadHistoricalEarnings(
  fromMonth: string,
  beforeMonth: string,
  daysFrom: string,
): Promise<EarningsAggregate> {
  const admin = createAdminClient()

  // Filtered on the EMBEDDED task's date, not `calculated_at`, so a September
  // recalculation of a March task stays in March. `!inner` makes the filter
  // reach the join at all; a row with no task is dropped either way.
  const res = await fetchAll(admin
    .from('contribution_scores')
    .select('employee_id, score_percentage, earnings_inr, task:tasks!inner(id, quantity, task_date)')
    .gte('tasks.task_date', `${fromMonth}-01`)
    .lt('tasks.task_date', `${beforeMonth}-01`)
    // Newest first: `dedupeScores` keeps the first row it sees per
    // (employee, task), which must be the most recent calculation.
    .order('calculated_at', { ascending: false })
    .order('id', { ascending: true }))

  return aggregateEarnings((res.data || []) as unknown as ScoreRow[], daysFrom)
}
