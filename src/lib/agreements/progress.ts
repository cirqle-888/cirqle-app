/**
 * Client Agreements — Progress Engine
 *
 * Computes live numbers (Committed, Planned, Delivered, Remaining, Extra)
 * from the social calendar and tasks. Nothing is stored.
 *
 * Doctrine: for month M, the engine resolves the term row whose
 * [effective_from, effective_to] overlaps M, and derives all logic against it.
 */

import {
  ItemProgress,
  resolveItemProgress,
  ContentType,
} from '@/lib/social/plan'
import type {
  ClientAgreementRow,
  ClientAgreementItemRow,
  ClientAgreementDeliverableRow,
  ClientAgreementAdjustmentRow,
} from './types'

// ─── Core Types ──────────────────────────────────────────────────────────────

export interface DeliverableProgress {
  deliverableId: string
  label: string
  committed: number
  planned: number
  delivered: number
  remaining: number
  extra: number
}

export interface ItemProgressSummary {
  itemId: string
  serviceId: string | null
  displayOrder: number
  committed: number
  planned: number
  delivered: number
  remaining: number
  extra: number
  deliverables: DeliverableProgress[]
  /** True if under-planned (planned < committed) */
  isUnderPlanned: boolean
}

export interface AgreementProgressSummary {
  agreementId: string
  agreementNumber: string
  title: string
  status: string
  items: ItemProgressSummary[]
  totalCommitted: number
  totalPlanned: number
  totalDelivered: number
  totalRemaining: number
  totalExtra: number
}

/** Matches a calendar item (planned) */
export interface SourceCalendarItem {
  id: string
  service_id: string | null
  content_type: ContentType
  variants?: ContentType[] | null
  status: string // The calendar's internal status (e.g., 'planned', 'requested')
  linkedRequest?: any // the request join, needed for resolveItemProgress
}

/** Matches a raw task record */
export interface SourceTask {
  id: string
  service_id: string | null
  task_date: string
  status: string
  quantity: number
  deleted_at: string | null
  isExplicitlyLinked?: boolean // true if joined via client_agreement_tasks
}

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

interface ComputeContext {
  month: string
  agreement: ClientAgreementRow
  termRow: ClientAgreementItemRow
  deliverables: ClientAgreementDeliverableRow[]
  adjustments: ClientAgreementAdjustmentRow[] // for manual carry-forward
  calendarItems: SourceCalendarItem[] // already filtered to this client & month
  tasks: SourceTask[] // already filtered to this client & month (or global for one_time)
  carryInRemaining: number // fed from the recursion
}

/**
 * Rule 3: Every unit attributes to exactly one deliverable.
 * Matches first by display_order.
 */
function matchDeliverable(
  unitType: ContentType,
  unitServiceId: string | null,
  deliverables: ClientAgreementDeliverableRow[],
  itemServiceId: string | null
): ClientAgreementDeliverableRow | null {
  for (const d of deliverables) {
    if (d.content_types.length === 0) {
      if (unitServiceId === itemServiceId) return d
    } else {
      if (d.content_types.includes(unitType)) return d
    }
  }
  return null
}

export function computeItemProgress(ctx: ComputeContext): ItemProgressSummary {
  const { month, termRow, agreement, deliverables, calendarItems, tasks, carryInRemaining } = ctx
  const isOneTime = termRow.commitment_type === 'one_time'

  // 1. Calculate committed baseline
  let baseCommitted = 0
  if (deliverables.length === 0) {
    baseCommitted = prorateCommitted(termRow.committed_quantity || 0, month, termRow, agreement)
  } else {
    // Deliverables are the source of truth if they exist
    baseCommitted = deliverables.reduce(
      (sum, d) => sum + prorateCommitted(d.committed_quantity, month, termRow, agreement),
      0
    )
  }
  baseCommitted += carryInRemaining // apply carry-forward

  // Initialize trackers
  const delMap = new Map<string, DeliverableProgress>()
  for (const d of deliverables) {
    delMap.set(d.id, {
      deliverableId: d.id,
      label: d.label,
      committed: prorateCommitted(d.committed_quantity, month, termRow, agreement),
      planned: 0,
      delivered: 0,
      remaining: 0,
      extra: 0,
    })
  }
  
  // Track out-of-calendar extra tasks explicitly
  let safetyNetDelivered = 0

  // 2. Process Calendar Items
  // "A calendar item is 1 unit of its content_type, and each value in its variants[] array is 1 additional unit"
  const processedCalendarTaskIds = new Set<string>()

  for (const calItem of calendarItems) {
    // Rule 1 & 4
    const resolvedProgress = resolveItemProgress(calItem.status, calItem.linkedRequest)
    if (resolvedProgress === 'cancelled') continue
    
    // Remember the promoted task ID to prevent double-counting via safety net
    if (calItem.linkedRequest?.promoted_task?.id) {
      processedCalendarTaskIds.add(calItem.linkedRequest.promoted_task.id)
    }

    const units = [calItem.content_type, ...(calItem.variants || [])]
    for (const unitType of units) {
      const match = matchDeliverable(unitType, calItem.service_id, deliverables, termRow.service_id)
      
      const isDelivered = resolvedProgress === 'delivered' || resolvedProgress === 'done'
      
      if (match) {
        const d = delMap.get(match.id)!
        d.planned += 1
        if (isDelivered) d.delivered += 1
      } else if (isDelivered) {
        // Did not match a typed deliverable, but is delivered work.
        // It falls to the item-level safety net.
        safetyNetDelivered += 1
      }
    }
  }

  // 3. Process Tasks (Safety net & explicitly linked tasks)
  for (const task of tasks) {
    if (task.deleted_at) continue // soft-deleted tasks never count
    const isCompleted = ['delivered', 'done', 'invoiced', 'paid'].includes(task.status)
    if (!isCompleted) continue
    
    if (processedCalendarTaskIds.has(task.id)) continue // skip double counting

    if (task.isExplicitlyLinked) {
      // Explicit links count fully towards the item/deliverable if possible
      // (Without a content_type, we attribute to the first matching service deliverable, 
      // or to the generic safety net if no deliverables match).
      const match = matchDeliverable('other', task.service_id, deliverables, termRow.service_id)
      if (match) {
        const d = delMap.get(match.id)!
        d.delivered += task.quantity
      } else {
        safetyNetDelivered += task.quantity
      }
    } else {
      // Safety net: tasks under the same service ID that aren't linked or from the calendar
      if (task.service_id === termRow.service_id) {
        safetyNetDelivered += task.quantity
      }
    }
  }

  // 4. Rollup
  let totalCommitted = baseCommitted
  let totalPlanned = 0
  let totalDelivered = safetyNetDelivered

  for (const d of delMap.values()) {
    d.remaining = Math.max(0, d.committed - d.delivered)
    d.extra = Math.max(0, d.delivered - d.committed)
    
    totalPlanned += d.planned
    totalDelivered += d.delivered
  }

  const remaining = Math.max(0, totalCommitted - totalDelivered)
  const extra = Math.max(0, totalDelivered - totalCommitted)

  return {
    itemId: termRow.id,
    serviceId: termRow.service_id,
    displayOrder: termRow.display_order,
    committed: totalCommitted,
    planned: totalPlanned,
    delivered: totalDelivered,
    remaining,
    extra,
    deliverables: Array.from(delMap.values()).sort((a, b) => 
      (deliverables.find(x => x.id === a.deliverableId)?.display_order || 0) - 
      (deliverables.find(x => x.id === b.deliverableId)?.display_order || 0)
    ),
    isUnderPlanned: totalPlanned < totalCommitted,
  }
}
