/**
 * Package coverage — the one place that decides what a package has delivered
 * and which tasks its fee already pays for.
 *
 * Pure and framework-free, so the Packages page, the invoice builder and the
 * profit calculation all reach the same answer from the same inputs. The old
 * agreement engine stamped this verdict onto the task row (`retainer_item_id`,
 * `work_value_inr`) and then drifted whenever anything upstream changed; here
 * nothing is stored, so there is nothing to go stale.
 *
 * Two rules:
 *
 *   1. A task fulfils the included line whose `service_id` it matches. The
 *      UNIQUE (package_id, service_id) constraint guarantees at most one.
 *
 *   2. Within a period, a line's tasks are ordered oldest-first; the first
 *      `included_quantity` are COVERED and the rest are EXTRA. Ordering is by
 *      `task_date` then `task_number` so it is deterministic — without the
 *      tie-break, two tasks on the same day could swap places between reads
 *      and a task would flip between covered and billable.
 *
 * Period: a calendar month for `monthly` (the allowance resets), all-time for
 * `one_time` (the allowance is the whole package).
 */

import type {
  PackageBillingType, PackageItemRow, PackageTaskLike,
  PackageCoverage, ItemProgress,
} from './types'

/**
 * Statuses that mean the work actually happened.
 *
 * `invoiced` is a post-done state, not a separate kind of work — a task that
 * has been billed was obviously delivered.
 */
const DELIVERED_STATUSES = new Set(['done', 'invoiced'])

/**
 * Has this task been delivered?
 *
 * A missing status means the caller didn't select the column; assume delivered
 * rather than silently zeroing a client's progress. Every real caller selects
 * it — this default only protects a partial query, it isn't the normal path.
 */
export function isDelivered(status?: string | null): boolean {
  return status == null ? true : DELIVERED_STATUSES.has(status)
}

/** Abandoned work. Counts toward nothing — not delivered, not scheduled. */
export function isCancelled(status?: string | null): boolean {
  return status === 'cancelled'
}

/** The `YYYY-MM` a task falls in. */
export function taskMonth(taskDate: string): string {
  return String(taskDate ?? '').slice(0, 7)
}

/** Last calendar day of a `YYYY-MM`, leap years included. */
export function lastDayOfMonth(month: string): string {
  const [y, m] = String(month ?? '').slice(0, 7).split('-').map(Number)
  // A blank or malformed month must not throw on toISOString — the form can hold
  // a half-typed date, and a crashing render is worse than an unusable answer.
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return ''
  // Day 0 of the NEXT month is the last day of this one.
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

/**
 * One billing cycle of a package: the span its allowance covers, and the single
 * invoice month that carries its fee.
 *
 * Normally a cycle is just a calendar month. The exception is an extended
 * OPENING cycle (`first_cycle_end`), for a retainer that starts mid-month: a
 * package signed on 20 July shouldn't cost a full month's fee for eleven days,
 * so the first cycle runs 20 Jul → 31 Aug, bills once, and carries ONE allowance
 * across the whole span.
 */
export interface BillingCycle {
  /** Inclusive first date the cycle counts. */
  start: string
  /** Inclusive last date the cycle counts. */
  end: string
  /** The invoice month that carries this cycle's fee — `YYYY-MM`. */
  billingMonth: string
  /** True when this is the extended opening cycle. */
  isFirstCycle: boolean
}

/** The package fields the cycle calculation reads. Nothing else is needed. */
export interface PackageCycleFields {
  billing_type: PackageBillingType
  start_date: string
  first_cycle_end?: string | null
}

/** Wide enough to mean "no bound" in a string date comparison. */
const DATE_MIN = '0000-01-01'
const DATE_MAX = '9999-12-31'

/**
 * Which cycle an invoice month belongs to.
 *
 * `first_cycle_end` is read to the END OF ITS MONTH deliberately. Anchoring on
 * the month rather than the exact day means there is no gap: pick 15 Aug by
 * mistake and the opening cycle still runs to 31 Aug, instead of leaving 16–31
 * Aug in no cycle at all, uncounted and unbilled.
 *
 * `one_time` has no cycles — its allowance is the package's whole life, so the
 * span is unbounded and every linked task counts however it is dated.
 */
export function cycleForMonth(pkg: PackageCycleFields, month: string): BillingCycle {
  if (pkg.billing_type === 'one_time') {
    return { start: DATE_MIN, end: DATE_MAX, billingMonth: month, isFirstCycle: false }
  }

  const startMonth = taskMonth(pkg.start_date)
  const firstEndMonth = pkg.first_cycle_end ? taskMonth(pkg.first_cycle_end) : null

  // Only an opening cycle that actually spans past its starting month changes
  // anything; set within the start month it is a no-op, not an error.
  if (firstEndMonth && firstEndMonth > startMonth && month >= startMonth && month <= firstEndMonth) {
    return {
      start: pkg.start_date,
      end: lastDayOfMonth(firstEndMonth),
      billingMonth: startMonth,
      isFirstCycle: true,
    }
  }

  return {
    start: `${month}-01`,
    end: lastDayOfMonth(month),
    billingMonth: month,
    isFirstCycle: false,
  }
}

/** Tasks dated inside a cycle. */
export function tasksInCycle<T extends PackageTaskLike>(tasks: T[], cycle: BillingCycle): T[] {
  return tasks.filter(t => {
    const d = String(t.task_date ?? '')
    return d >= cycle.start && d <= cycle.end
  })
}

/**
 * Tasks that count toward a period.
 *
 * `monthly` counts only the given month, because the allowance resets each
 * month — 15 posts in August says nothing about September. `one_time` counts
 * everything, because the allowance covers the package's whole life.
 *
 * `month` is `YYYY-MM`. It is ignored for `one_time`.
 */
export function tasksInPeriod<T extends PackageTaskLike>(
  tasks: T[],
  billingType: PackageBillingType,
  month: string,
): T[] {
  if (billingType === 'one_time') return tasks
  return tasks.filter(t => taskMonth(t.task_date) === month)
}

/** Oldest first, with a stable tie-break so the verdict never flips between reads. */
function byDeliveryOrder(a: PackageTaskLike, b: PackageTaskLike): number {
  const d = String(a.task_date ?? '').localeCompare(String(b.task_date ?? ''))
  if (d !== 0) return d
  return (a.task_number ?? 0) - (b.task_number ?? 0)
}

/**
 * Resolve what a package has delivered in a period, and which of its tasks the
 * fee covers.
 *
 * A task whose service matches no included line is neither covered nor extra —
 * it is simply not part of the package, and bills on its own as any ordinary
 * task would. That is the honest reading: the client never agreed to it as
 * part of this bundle. It is reported in `unmatchedTaskIds` so the UI can point
 * it out rather than leaving it silently absent.
 */
export function resolveCoverage(
  tasks: PackageTaskLike[],
  items: PackageItemRow[],
  billingType: PackageBillingType,
  month: string,
  cycle?: BillingCycle | null,
): PackageCoverage & { unmatchedTaskIds: string[] } {
  const inPeriod = cycle ? tasksInCycle(tasks, cycle) : tasksInPeriod(tasks, billingType, month)

  // service_id → its tasks, oldest first.
  const byService = new Map<string, PackageTaskLike[]>()
  const matchedServiceIds = new Set(items.map(i => i.service_id))
  const unmatchedTaskIds: string[] = []

  for (const t of inPeriod) {
    // Abandoned work is not owed, not delivered, and not billable. It leaves
    // the calculation entirely rather than lingering as a phantom deliverable.
    if (isCancelled(t.status)) continue
    if (!t.service_id || !matchedServiceIds.has(t.service_id)) {
      unmatchedTaskIds.push(t.id)
      continue
    }
    const arr = byService.get(t.service_id)
    if (arr) arr.push(t)
    else byService.set(t.service_id, [t])
  }
  for (const arr of byService.values()) arr.sort(byDeliveryOrder)

  const perItem: ItemProgress[] = []
  const coveredTaskIds: string[] = []
  const extraTaskIds: string[] = []
  const scheduledTaskIds: string[] = []

  // Ordered by display_order so the UI reads the way the package was written.
  const ordered = [...items].sort((a, b) => a.display_order - b.display_order)

  for (const item of ordered) {
    const all = byService.get(item.service_id) ?? []
    const included = Math.max(0, item.included_quantity)

    // Only FINISHED work consumes the allowance.
    //
    // This is a money rule, not a cosmetic one. Ordering unfinished tasks in
    // with the rest lets a task that was merely created early take a covered
    // slot and push a genuinely delivered one past `included` — where it bills
    // the client as overage for work their fee already paid for.
    const delivered = all.filter(t => isDelivered(t.status))
    const scheduled = all.filter(t => !isDelivered(t.status))

    coveredTaskIds.push(...delivered.slice(0, included).map(t => t.id))
    extraTaskIds.push(...delivered.slice(included).map(t => t.id))
    scheduledTaskIds.push(...scheduled.map(t => t.id))

    perItem.push({
      serviceId: item.service_id,
      included,
      delivered: delivered.length,
      scheduled: scheduled.length,
      remaining: Math.max(0, included - delivered.length),
      extra: Math.max(0, delivered.length - included),
    })
  }

  return {
    perItem,
    coveredTaskIds,
    extraTaskIds,
    scheduledTaskIds,
    unmatchedTaskIds,
    totalIncluded: perItem.reduce((s, i) => s + i.included, 0),
    totalDelivered: perItem.reduce((s, i) => s + i.delivered, 0),
    totalScheduled: perItem.reduce((s, i) => s + i.scheduled, 0),
    totalRemaining: perItem.reduce((s, i) => s + i.remaining, 0),
  }
}

/**
 * `resolveCoverage` for a real package — works out the cycle first.
 *
 * Prefer this everywhere a package row is in hand. Calling `resolveCoverage`
 * directly skips the cycle and so ignores an extended opening cycle, which would
 * show two allowances where the client agreed to one.
 */
export function resolveCoverageForPackage(
  pkg: PackageCycleFields,
  tasks: PackageTaskLike[],
  items: PackageItemRow[],
  month: string,
): PackageCoverage & { unmatchedTaskIds: string[] } {
  return resolveCoverage(tasks, items, pkg.billing_type, month, cycleForMonth(pkg, month))
}

/**
 * Is the package in force on this date?
 *
 * `paused` deliberately counts as NOT in force: pausing is how you stop a
 * retainer billing for a month without ending the commitment, so a paused
 * package must not put its fee on that month's invoice.
 */
export function isPackageInForce(
  pkg: { status: string; start_date: string; end_date: string | null; deleted_at?: string | null },
  onDate: string,
): boolean {
  if (pkg.deleted_at) return false
  if (pkg.status !== 'active') return false
  if (onDate < pkg.start_date) return false
  if (pkg.end_date && onDate > pkg.end_date) return false
  return true
}

/**
 * Does a MONTH overlap the package's term at all?
 *
 * Used for invoicing, where the question is "does this package belong on the
 * invoice for August?" rather than "is it in force on the 14th?". A retainer
 * that starts mid-month still bills for that month.
 */
export function isPackageInForceForMonth(
  pkg: { status: string; start_date: string; end_date: string | null; deleted_at?: string | null },
  month: string,
): boolean {
  if (pkg.deleted_at) return false
  if (pkg.status !== 'active') return false
  const monthStart = `${month}-01`
  const monthEnd = `${month}-31`          // string compare; safe for YYYY-MM-DD
  if (pkg.start_date > monthEnd) return false
  if (pkg.end_date && pkg.end_date < monthStart) return false
  return true
}
