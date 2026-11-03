/**
 * What "Refresh from tasks" would change on an invoice: the lines whose task
 * has moved on since the line was written, and the lines whose task should no
 * longer be billed.
 *
 * The automatic sync keeps only DRAFT lines in step with their tasks. Once an
 * invoice is reviewed or sent it is frozen, so a task re-priced, re-titled or
 * cancelled afterwards left the invoice wrong — and the only fix used to be
 * deleting it and regenerating. This is the comparison that lets the invoice
 * be corrected in place instead, after the person has seen every change.
 *
 * Pure: the server action loads the rows, this decides. Lines it never touches:
 *   - lines with no task (manual lines, expense rebills),
 *   - package fee lines and tasks under a package — the package sync owns
 *     their pricing (an over-allowance extra is billed at the package's rate,
 *     not the task's), so comparing them to the task would "fix" them wrongly.
 */

import { round2 } from '@/lib/calculations/currency'

export interface RefreshLine {
  id: string
  task_id: string | null
  package_id?: string | null
  description: string | null
  quantity: number | null
  unit_price: number | null
  total: number | null
  currency: string | null
}

export interface RefreshTask {
  id: string
  title: string | null
  quantity: number | null
  billing_amount: number | null
  billing_amount_inr?: number | null
  currency: string | null
  status: string
  deleted_at: string | null
  is_billable: boolean | null
  package_id: string | null
}

export type LineField = 'description' | 'quantity' | 'price'

export interface LineUpdate {
  itemId: string
  taskId: string
  /** What differs. `from`/`to` are absent for price when the viewer can't see prices. */
  changes: { field: LineField; from?: string | number; to?: string | number }[]
  /** The line as it would be written. Prices absent for a viewer without line pricing. */
  next: { description: string; quantity: number; unit_price?: number; total?: number }
}

export type RemovalReason = 'deleted' | 'cancelled' | 'waived' | 'missing'

export interface LineRemoval {
  itemId: string
  taskId: string
  description: string
  why: RemovalReason
  /** Absent for a viewer without line pricing. */
  total?: number
}

const MONEY_EPS = 0.005

/** The task's line total in its own currency — same convention as Generate from tasks. */
export function taskLineTotal(t: Pick<RefreshTask, 'billing_amount' | 'billing_amount_inr'>): number {
  return Number(t.billing_amount ?? t.billing_amount_inr ?? 0)
}

export function diffInvoiceAgainstTasks(
  lines: RefreshLine[],
  tasks: Map<string, RefreshTask>,
): { update: LineUpdate[]; remove: LineRemoval[] } {
  const update: LineUpdate[] = []
  const remove: LineRemoval[] = []

  for (const line of lines) {
    if (!line.task_id || line.package_id) continue
    const task = tasks.get(line.task_id)
    const description = line.description ?? ''

    const why: RemovalReason | null = !task ? 'missing'
      : task.deleted_at ? 'deleted'
      : task.status === 'cancelled' ? 'cancelled'
      : task.is_billable === false ? 'waived'
      : null
    if (why) {
      remove.push({ itemId: line.id, taskId: line.task_id, description, why, total: Number(line.total ?? 0) })
      continue
    }
    if (!task || task.package_id) continue

    const changes: LineUpdate['changes'] = []
    const title = (task.title ?? '').trim()
    if (title && title !== description.trim()) changes.push({ field: 'description', from: description, to: title })

    // Quantity and price only compare within one currency: a task re-priced
    // in another currency is not something to copy onto this invoice blindly.
    const sameCurrency = (task.currency || 'INR') === (line.currency || 'INR')
    const lineQty = Number(line.quantity ?? 1) || 1
    const taskQty = Number(task.quantity ?? 1) || 1
    const lineTotal = Number(line.total ?? 0)
    const taskTotal = taskLineTotal(task)
    if (sameCurrency && taskQty !== lineQty) changes.push({ field: 'quantity', from: lineQty, to: taskQty })
    if (sameCurrency && Math.abs(taskTotal - lineTotal) > MONEY_EPS) changes.push({ field: 'price', from: lineTotal, to: taskTotal })

    if (!changes.length) continue
    const qty = sameCurrency ? taskQty : lineQty
    const total = sameCurrency ? taskTotal : lineTotal
    update.push({
      itemId: line.id,
      taskId: task.id,
      changes,
      next: { description: title || description, quantity: qty, total, unit_price: round2(total / qty) },
    })
  }

  return { update, remove }
}

/** Drop every money figure, for a viewer without billing.view_line_pricing. */
export function stripDiffPrices<T extends { update: LineUpdate[]; remove: LineRemoval[] }>(diff: T): T {
  return {
    ...diff,
    update: diff.update.map(u => ({
      ...u,
      changes: u.changes.map(c => c.field === 'price' ? { field: c.field } : c),
      next: { description: u.next.description, quantity: u.next.quantity },
    })),
    remove: diff.remove.map(({ total: _total, ...r }) => r),
  }
}
