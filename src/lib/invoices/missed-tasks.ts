import type { LineRemoval, LineUpdate } from './refresh-diff'

/**
 * A finished, billable task that is on no live invoice — see findMissedTasks
 * in app/(dashboard)/dashboard/invoices/actions.ts. Kept here because a
 * 'use server' module may only export async functions.
 */
export interface MissedTask {
  id: string
  title: string
  task_date: string | null
  status: string
  quantity: number | null
  currency: string | null
  /** Absent for a user without billing.view_line_pricing. */
  billing_amount?: number | null
  service_name: string | null
}

/** What "Refresh from tasks" would do to one invoice — see previewInvoiceRefresh. */
export interface InvoiceRefreshPreview {
  add: MissedTask[]
  update: LineUpdate[]
  remove: LineRemoval[]
}

// ── Duplicate-billing guards ─────────────────────────────────────────────────

/** One live invoice a task is already billed on. */
export interface BilledOn {
  invoice_id: string
  invoice_number: string
  status: string
}

/**
 * task_id → the live invoices it already sits on. A task with no key is on no
 * live invoice and is safe to bill. See tasksAlreadyBilled in
 * app/(dashboard)/dashboard/invoices/actions.ts.
 */
export type BilledTaskMap = Record<string, BilledOn[]>

/** A live invoice that already covers one client's billing month. */
export interface CoveringInvoice {
  id: string
  invoice_number: string
  status: string
  currency: string | null
  /** True when addTasksToInvoice can still put lines on it. */
  editable: boolean
  /** True when adding lines needs a reason for the edit history. */
  needsReason: boolean
}

/** `${client_id}__${month}` → the live invoice covering that month. */
export type CoveringInvoiceMap = Record<string, CoveringInvoice>
