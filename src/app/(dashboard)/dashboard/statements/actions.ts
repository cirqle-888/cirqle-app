'use server'

/**
 * Line items for statement invoices, on demand.
 *
 * A SERVER action, not a browser query, for the same reason the invoices page
 * loads its detail this way: `invoice_items.unit_price` is removed for a viewer
 * without `billing.view_line_pricing`, and RLS is `authenticated USING(true)`,
 * so fetching these rows from the client would hand over the pricing the page
 * takes care to withhold.
 *
 * Fetched per expanded invoice rather than shipped with the page — a statement
 * only ever expands a handful, and all 1,909 item rows would dwarf the ledger
 * payload itself.
 */
import { loadCurrentUser, requireReadPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { financialVisibility } from '@/lib/permissions/strip'
import { createAdminClient } from '@/lib/supabase/admin'

export interface StatementLineItem {
  id: string
  invoice_id: string
  description: string | null
  quantity: number | null
  unit_price: number | null
  total: number | null
  line_date: string | null
  task_title: string | null
  task_date: string | null
  service_name: string | null
}

interface Result {
  ok: boolean
  error?: string
  data?: StatementLineItem[]
}

export async function getStatementLineItems(invoiceIds: string[]): Promise<Result> {
  const guard = await requireReadPermission(PERMS.BILLING_VIEW_INVOICES)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!invoiceIds.length) return { ok: true, data: [] }

  const me = await loadCurrentUser().catch(() => null)
  const vis = financialVisibility(me)

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('invoice_items')
    // The task's service is joined as well as the line's own: no invoice_item
    // in production carries service_id, because the auto-collect path files the
    // task and lets the task hold the service. `services!service_id` is
    // mandatory — tasks has two foreign keys to services and an unqualified
    // embed silently returns nothing.
    .select('id, invoice_id, description, quantity, unit_price, total, line_date, task:tasks(title, task_date, service:services!service_id(name)), service:services(name)')
    .in('invoice_id', invoiceIds)

  if (error) return { ok: false, error: error.message }

  const rows: StatementLineItem[] = (data || []).map((r: Record<string, unknown>) => {
    const task = r.task as { title?: string; task_date?: string; service?: { name?: string } | null } | null
    const service = r.service as { name?: string } | null
    return {
      id: String(r.id),
      invoice_id: String(r.invoice_id),
      description: (r.description as string) ?? null,
      quantity: (r.quantity as number) ?? null,
      // Per-line pricing is gated; the line total is billing_amounts, which the
      // statement's own totals already depend on.
      unit_price: vis.billingLinePricing ? ((r.unit_price as number) ?? null) : null,
      total: vis.billingAmounts ? ((r.total as number) ?? null) : null,
      line_date: (r.line_date as string) ?? null,
      task_title: task?.title ?? null,
      task_date: task?.task_date ?? null,
      service_name: service?.name ?? task?.service?.name ?? null,
    }
  })

  return { ok: true, data: rows }
}
