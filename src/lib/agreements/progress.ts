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
 * Committed is still prorated by active days in the month, so an agreement
 * starting mid-month commits a part-month quantity. Surface that in the UI —
 * an unexplained "8" against a promised 15 reads as a bug.
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
  committed: number
  delivered: number
  remaining: number
  /** Delivered beyond the commitment. Still delivered work — it bills separately if flagged. */
  extra: number
}

export interface AgreementProgressSummary {
  agreementId: string
  agreementNumber: string
  title: string
  status: string
  items: ItemProgressSummary[]
  totalCommitted: number
  totalDelivered: number
  totalRemaining: number
  totalExtra: number
}

/** Aggregate of one or more agreement summaries — powers headline meters/cards. */
export interface AgreementProgressRollup {
  /** Number of summaries with an `active` status (paused/others excluded). */
  activeAgreements: number
  committed: number
  delivered: number
  remaining: number
  extra: number
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

/**
 * Computes the prorated committed quantity for a term row in month M.
 * committed(M) = qty * activeDays(M) / daysInMonth(M)
 * activeDays clips the row's window by the agreement's [start_date, end_date].
 */
export function prorateCommitted(
  qty: number,
  month: string,
  termRow: ClientAgreementItemRow,
  agreement: ClientAgreementRow
): number {
  if (termRow.commitment_type === 'one_time') {
    return qty // one_time items are not prorated by month
  }

  const [y, m] = month.split('-').map(Number)
  const daysInMonth = getDaysInMonth(y, m)
  const monthStart = `${month}-01`
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, '0')}`

  // Determine the effective bounds for the row in this specific month,
  // bounded by the agreement's global start/end dates.
  const startBound = [monthStart, termRow.effective_from, agreement.start_date]
    .sort((a, b) => b.localeCompare(a))[0] // MAX

  const endBounds = [monthEnd]
  if (termRow.effective_to) endBounds.push(termRow.effective_to)
  if (agreement.end_date) endBounds.push(agreement.end_date)
  const endBound = endBounds.sort((a, b) => a.localeCompare(b))[0] // MIN

  // If bounds are inverted, 0 active days
  if (startBound > endBound) return 0

  const dStart = new Date(startBound).getTime()
  const dEnd = new Date(endBound).getTime()
  const activeDays = Math.max(0, Math.round((dEnd - dStart) / (1000 * 60 * 60 * 24)) + 1)

  if (activeDays >= daysInMonth) return qty
  return Math.round((qty * activeDays) / daysInMonth)
}

// ─── Computation Engine ──────────────────────────────────────────────────────

export interface ComputeContext {
  month: string
  agreement: ClientAgreementRow
  termRow: ClientAgreementItemRow
  /** Sub-lines of the item. Used only to total the commitment, not to split delivery. */
  deliverables: ClientAgreementDeliverableRow[]
  adjustments?: ClientAgreementAdjustmentRow[]
  /** Already filtered to this client & month (or global for one_time items). */
  tasks: SourceTask[]
  /** Unmet commitment rolled in from the previous month. */
  carryInRemaining: number
}

export function computeItemProgress(ctx: ComputeContext): ItemProgressSummary {
  const { month, termRow, agreement, deliverables, tasks, carryInRemaining } = ctx

  // ── Committed ──────────────────────────────────────────────────────────────
  // Deliverables, when present, are the source of truth for the quantity.
  let committed =
    deliverables.length > 0
      ? deliverables.reduce(
          (sum, d) => sum + prorateCommitted(d.committed_quantity, month, termRow, agreement),
          0,
        )
      : prorateCommitted(termRow.committed_quantity || 0, month, termRow, agreement)

  committed += carryInRemaining

  // ── Delivered — the single rule ────────────────────────────────────────────
  let delivered = 0
  for (const task of tasks) {
    if (task.deleted_at) continue
    if (!task.retainer_item_id || task.retainer_item_id !== termRow.id) continue
    if (!DELIVERED_STATUSES.includes(task.status as typeof DELIVERED_STATUSES[number])) continue
    delivered += Number(task.quantity) || 0
  }

  return {
    itemId: termRow.id,
    serviceId: termRow.service_id,
    displayOrder: termRow.display_order,
    committed,
    delivered,
    remaining: Math.max(0, committed - delivered),
    extra: Math.max(0, delivered - committed),
  }
}
