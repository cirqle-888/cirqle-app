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
