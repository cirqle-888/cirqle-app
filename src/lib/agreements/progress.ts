/**
 * Client Agreements — Progress Engine
 *
 * Answers one question: for month M, how much of what we committed have we
 * delivered? Nothing is stored; everything is derived.
 *
 * ── The single rule ─────────────────────────────────────────────────────────
 * Delivered = SUM(task.quantity) for tasks that are
 *   (a) stamped with this term row's id in tasks.retainer_item_id,
 *   (b) in a completed status, and
 *   (c) not soft-deleted.
 *
 * `retainer_item_id` is written by the billing-coverage engine — the same stamp
 * that zeroes client billing on a covered task. Progress and billing therefore
 * read one source and can never disagree.
 *
 * This replaced four competing rules (calendar items counted as 1 per unit,
 * stamped tasks by quantity, explicitly-linked tasks by quantity, and a
 * same-service safety net). They mixed units of measure — items vs quantity —
 * inside one total, and the calendar path was fed by an invalid PostgREST
 * filter, so it had been contributing zero in production without anyone
 * noticing. Counting `quantity` (not tasks) matters: one task with quantity 4
 * consumes 4 of a 15-unit commitment.
 *
 * ── Periods, not calendar months ────────────────────────────────────────────
 * A retainer's commitment recurs per *period*. For an agreement starting on the
 * 1st a period is just the calendar month. For one starting mid-month the first
 * calendar month is a stub — too short to owe a full cycle, too real to ignore —
 * so it is MERGED into the following month: one period spanning [start_date,
 * end of the next month], owing one full cycle. Both calendar months resolve to
 * that same period, so a task dated in the stub month and the card the user
 * reads in the following month agree on the same numbers.
 *
 * The alternative — prorating the stub month — stranded delivery: work done on
 * 29 Jul counted against a prorated 6, then vanished from every later view while
 * August restarted at 15. Merging keeps that work inside the commitment it was
 * actually delivered against.
 *
 * one_time items do NOT recur. They commit once, in the period containing their
 * effective_from, and contribute nothing thereafter. Counting them every month
 * (the old behaviour, since effective_to is normally NULL) silently inflated the
 * monthly commitment forever — a 15-post retainer plus a 2-unit logo build read
 * as "17 committed" in every month for the life of the agreement.
 */

import type {
  ClientAgreementRow,
  ClientAgreementItemRow,
  ClientAgreementDeliverableRow,
  ClientAgreementAdjustmentRow,
} from './types'

// ─── Core Types ──────────────────────────────────────────────────────────────

export interface ItemProgressSummary {
  itemId: string
  serviceId: string | null
  displayOrder: number
  /** The window this row's figures were computed over. */
  period: DeliveryPeriod
  committed: number
  /** Work that consumed the included allowance. Excludes bill-as-extra tasks. */
  delivered: number
  remaining: number
  /** Delivered beyond the commitment (delivered > committed). */
  extra: number
  /**
   * Covered tasks the client is billed for separately (`bill_as_extra`). Counted
   * and shown, but deliberately NOT consuming the allowance: charging for a task
   * *and* spending one of the included units would bill the client twice for it.
   */
  extraBilled: number
}

export interface AgreementProgressSummary {
  agreementId: string
  agreementNumber: string
  title: string
  status: string
  items: ItemProgressSummary[]
  /**
   * What the cards should call this period. Usually the 'YYYY-MM' asked for, but
   * an explicit date range when a mid-month start merged two calendar months.
   */
  periodLabel: string
  totalCommitted: number
  totalDelivered: number
  totalRemaining: number
  totalExtra: number
  /** Covered work billed separately — shown, but not consuming the allowance. */
  totalExtraBilled: number
}

/** Aggregate of one or more agreement summaries — powers headline meters/cards. */
export interface AgreementProgressRollup {
  /** Number of summaries with an `active` status (paused/others excluded). */
  activeAgreements: number
  committed: number
  delivered: number
  remaining: number
  extra: number
  extraBilled: number
  /** Delivered ÷ committed, 0–100 (0 when nothing is committed). */
  completionPct: number
}

/**
 * Sum a set of per-agreement summaries into a single rollup. Pure — no I/O — so
 * every consumer reuses one reduce instead of duplicating the arithmetic. Only
 * `active` agreements contribute; pass already-scoped input (e.g. one client's
 * summaries) to scope the rollup.
 */
export function rollupAgreementProgress(
  summaries: AgreementProgressSummary[],
): AgreementProgressRollup {
  const active = summaries.filter(s => s.status === 'active')
  const committed = active.reduce((sum, s) => sum + (s.totalCommitted || 0), 0)
  const delivered = active.reduce((sum, s) => sum + (s.totalDelivered || 0), 0)
  return {
    activeAgreements: active.length,
    committed,
    delivered,
    remaining: active.reduce((sum, s) => sum + (s.totalRemaining || 0), 0),
    extra: active.reduce((sum, s) => sum + (s.totalExtra || 0), 0),
    extraBilled: active.reduce((sum, s) => sum + (s.totalExtraBilled || 0), 0),
    completionPct: committed > 0 ? Math.min(100, Math.round((delivered / committed) * 100)) : 0,
  }
}

/** Minimal task shape the engine needs. */
export interface SourceTask {
  id: string
  service_id: string | null
  task_date: string
  status: string
  quantity: number
  deleted_at: string | null
  /** Agreement item the coverage engine linked this task to (tasks.retainer_item_id). */
  retainer_item_id?: string | null
  /** Covered, but billed to the client separately instead of consuming the allowance. */
  bill_as_extra?: boolean | null
}

/** A task in one of these statuses counts as delivered. */
export const DELIVERED_STATUSES = ['delivered', 'done', 'invoiced', 'paid'] as const

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/**
 * Resolves the single applicable term row for a given month.
 * Uses inclusive string comparison on YYYY-MM.
 *
 * @param month 'YYYY-MM'
 * @param rows All historical/future term rows for an item
 */
export function resolveTermRows(
  month: string,
  rows: ClientAgreementItemRow[]
): ClientAgreementItemRow | null {
  const startOfMonth = `${month}-01`
  const [y, m] = month.split('-').map(Number)
  const endOfMonth = `${month}-${String(getDaysInMonth(y, m)).padStart(2, '0')}`

  const validRows = rows.filter(r => {
    // If effective_from is after the month ends, it doesn't apply
    if (r.effective_from > endOfMonth) return false
    // If effective_to is before the month starts, it doesn't apply
    if (r.effective_to && r.effective_to < startOfMonth) return false
    return true
  })

  // Return the latest one if there are overlaps (usually shouldn't be for closed rows)
  if (validRows.length === 0) return null
  validRows.sort((a, b) => b.effective_from.localeCompare(a.effective_from))
  return validRows[0]
}

export function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${month}-${String(getDaysInMonth(y, m)).padStart(2, '0')}`
}

export function addMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function daysBetween(start: string, end: string): number {
  const ms = new Date(end).getTime() - new Date(start).getTime()
  return Math.max(0, Math.round(ms / 86_400_000) + 1)
}

/** The window a period's delivery is counted over, and what it owes. */
export interface DeliveryPeriod {
  /** Inclusive first day a task may be dated to count in this period. */
  start: string
  /** Inclusive last day. */
  end: string
  /** For the UI: 'YYYY-MM', or an explicit range when a stub month was merged. */
  label: string
  /** True when a mid-month start pulled the preceding stub month into this one. */
  mergedStartStub: boolean
  /** True when the term row owes nothing in this period (e.g. a spent one_time). */
  inactive: boolean
}

/**
 * Resolves which delivery period the calendar month `month` belongs to for a
 * given term row. See the module header for why a mid-month start merges two
 * calendar months into one period.
 */
export function resolveDeliveryPeriod(
  month: string,
  agreement: ClientAgreementRow,
  termRow: ClientAgreementItemRow,
): DeliveryPeriod {
  const plain = (inactive: boolean): DeliveryPeriod => ({
    start: `${month}-01`,
    end: lastDayOf(month),
    label: month,
    mergedStartStub: false,
    inactive,
  })

  // A one_time item commits once, in the period holding its effective_from.
  if (termRow.commitment_type === 'one_time') {
    const firstMonth = termRow.effective_from.slice(0, 7)
    if (month !== firstMonth) return plain(true)
    return {
      start: termRow.effective_from,
      end: lastDayOf(month),
      label: month,
      mergedStartStub: false,
      inactive: false,
    }
  }

  // Retainer. A start on the 1st needs no merging — periods are calendar months.
  const start = agreement.start_date
  const startMonth = start.slice(0, 7)
  if (start.slice(8, 10) === '01' || month < startMonth) return plain(month < startMonth)

  const mergedInto = addMonth(startMonth, 1)
  if (month === startMonth || month === mergedInto) {
    return {
      start,
      end: lastDayOf(mergedInto),
      label: `${start} → ${lastDayOf(mergedInto)}`,
      mergedStartStub: true,
      inactive: false,
    }
  }
  return plain(false)
}

/**
 * Committed quantity for a term row over `period`.
 *
 * A merged first period owes exactly one cycle — the point of merging is that
 * the stub month does not owe a second one. Proration survives only for the
 * *end* of a commitment (a term row or agreement ending mid-period), where a
 * part-period really does owe part of a cycle.
 */
export function periodCommitted(
  qty: number,
  period: DeliveryPeriod,
  termRow: ClientAgreementItemRow,
  agreement: ClientAgreementRow,
): number {
  if (period.inactive) return 0
  if (termRow.commitment_type === 'one_time') return qty

  const endBounds = [period.end]
  if (termRow.effective_to) endBounds.push(termRow.effective_to)
  if (agreement.end_date) endBounds.push(agreement.end_date)
  const endBound = endBounds.sort((a, b) => a.localeCompare(b))[0] // MIN

  const startBound = [period.start, termRow.effective_from]
    .sort((a, b) => b.localeCompare(a))[0] // MAX

  if (startBound > endBound) return 0

  // The merged first period is intentionally longer than a month; measure the
  // shortfall against the period itself, never against a fixed 30/31 days.
  const periodDays = daysBetween(period.start, period.end)
  const activeDays = daysBetween(startBound, endBound)
  if (activeDays >= periodDays) return qty
  return Math.round((qty * activeDays) / periodDays)
}

// ─── Computation Engine ──────────────────────────────────────────────────────

export interface ComputeContext {
  month: string
  agreement: ClientAgreementRow
  termRow: ClientAgreementItemRow
  /** Sub-lines of the item. Used only to total the commitment, not to split delivery. */
  deliverables: ClientAgreementDeliverableRow[]
  adjustments?: ClientAgreementAdjustmentRow[]
  /**
   * Client tasks covering at least this item's period. Dates outside the period
   * are filtered out here, so the caller may pass a wider range.
   */
  tasks: SourceTask[]
  /** Unmet commitment rolled in from the previous month. */
  carryInRemaining: number
  /** Defaults to `resolveDeliveryPeriod(month, agreement, termRow)`. */
  period?: DeliveryPeriod
}

export function computeItemProgress(ctx: ComputeContext): ItemProgressSummary {
  const { month, termRow, agreement, deliverables, tasks, carryInRemaining } = ctx
  const period = ctx.period ?? resolveDeliveryPeriod(month, agreement, termRow)

  // ── Committed ──────────────────────────────────────────────────────────────
  // Deliverables, when present, are the source of truth for the quantity.
  let committed =
    deliverables.length > 0
      ? deliverables.reduce(
          (sum, d) => sum + periodCommitted(d.committed_quantity, period, termRow, agreement),
          0,
        )
      : periodCommitted(termRow.committed_quantity || 0, period, termRow, agreement)

  committed += carryInRemaining

  // ── Delivered — the single rule ────────────────────────────────────────────
  let delivered = 0
  let extraBilled = 0
  for (const task of tasks) {
    if (task.deleted_at) continue
    if (task.task_date < period.start || task.task_date > period.end) continue
    if (!task.retainer_item_id || task.retainer_item_id !== termRow.id) continue
    if (!DELIVERED_STATUSES.includes(task.status as typeof DELIVERED_STATUSES[number])) continue

    const qty = Number(task.quantity) || 0
    // Billed separately => the client is paying for it on top of the retainer, so
    // it must not also spend one of the included units.
    if (task.bill_as_extra) extraBilled += qty
    else delivered += qty
  }

  return {
    itemId: termRow.id,
    serviceId: termRow.service_id,
    displayOrder: termRow.display_order,
    period,
    committed,
    delivered,
    remaining: Math.max(0, committed - delivered),
    extra: Math.max(0, delivered - committed),
    extraBilled,
  }
}
