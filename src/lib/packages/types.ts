/**
 * Package row types.
 *
 * Hand-written because `src/types/supabase.ts` is generated and already stale
 * for several live tables (it is missing `tasks.scope`, `tasks.billing_rule`
 * and `invoice_items.line_date` among others). Relying on it for a brand-new
 * table would mean typing against columns the generator has never seen.
 */

export type PackageBillingType = 'one_time' | 'monthly'
export type PackageStatus = 'active' | 'paused' | 'completed' | 'cancelled'

export interface PackageRow {
  id: string
  client_id: string
  /** Also the invoice line description — written to be read by a client. */
  name: string
  billing_type: PackageBillingType
  /** What the CLIENT pays. Never used to price a task or size the pool. */
  price: number
  currency: string
  /** Agreed overage rate per extra task. NULL → extras bill at the matrix price. */
  extra_task_price: number | null
  start_date: string
  /** NULL = ongoing. */
  end_date: string | null
  /**
   * Optional longer OPENING cycle, for a package that starts mid-month.
   *
   * The first cycle runs from `start_date` to the end of the month containing
   * this date — bills once for the whole span, and carries one allowance across
   * it. NULL = plain calendar months from the start. Monthly packages only.
   */
  first_cycle_end?: string | null
  status: PackageStatus
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface PackageItemRow {
  id: string
  package_id: string
  service_id: string
  /** Per MONTH for a monthly package; the total for a one_time package. */
  included_quantity: number
  display_order: number
  created_at: string
  updated_at: string
}

/** The task fields the coverage engine reads. Nothing else is needed. */
export interface PackageTaskLike {
  id: string
  service_id: string | null
  task_date: string
  /** Tie-break when two tasks share a date, so ordering is deterministic. */
  task_number?: number | null
  /**
   * Task status. A task that exists is not the same as work delivered — an
   * unfinished one must not consume the client's allowance.
   *
   * Optional so a caller that legitimately has no status still works; when it
   * is absent the task is assumed delivered. Every real caller selects it.
   */
  status?: string | null
}

/** One included line, with how much of it has been delivered. */
export interface ItemProgress {
  serviceId: string
  included: number
  /** Finished work. */
  delivered: number
  /** Linked tasks that exist but aren't finished — committed, not delivered. */
  scheduled: number
  /** Never negative — overage is reported via `extra`, not as a negative remainder. */
  remaining: number
  /** Delivered beyond `included`. */
  extra: number
}

export interface PackageCoverage {
  perItem: ItemProgress[]
  /** Tasks the package fee already pays for — these get NO individual invoice line. */
  coveredTaskIds: string[]
  /** Tasks beyond the included quantity — these bill separately. */
  extraTaskIds: string[]
  /** Linked but unfinished. Not covered and not extra until the work is done. */
  scheduledTaskIds: string[]
  /** Σ included across every line. */
  totalIncluded: number
  /** Σ delivered across every line, counting extras. */
  totalDelivered: number
  /** Σ scheduled-but-unfinished across every line. */
  totalScheduled: number
  /** Σ remaining across every line. */
  totalRemaining: number
}
