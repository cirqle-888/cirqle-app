/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Month-end billing check. Draft invoices already make themselves (a task
 * marked done lands on its client's month draft, see
 * find_or_create_client_month_draft), so what slips at month end is:
 *   · drafts nobody has sent,
 *   · finished work that reached no invoice,
 *   · work left at Delivered: it never reaches a draft until someone marks it
 *     done.
 * One notification a day in the window, with the money each one holds. It
 * changes nothing and sends nothing to clients.
 */
import type { Admin } from '@/lib/mcp/shared'
import { unbilledTasks } from '@/lib/mcp/ops-actions'
import { notifyAdmins } from '@/lib/notifications/create'
import { addDays, daysInMonth, monthLabel, monthStart } from './social-rules'

/** The month to close, or null outside the window (last two days, first three). */
export function billingMonth(today: string): string | null {
  const day = Number(today.slice(8, 10))
  const last = daysInMonth(monthStart(today))
  if (day >= last - 1) return monthStart(today)
  if (day <= 3) return monthStart(addDays(monthStart(today), -1))
  return null
}

export async function billingCheckJob(admin: Admin, today: string) {
  const month = billingMonth(today)
  if (!month) return { ok: true as const, skipped: 'outside the month-end window' }
  const monthEnd = `${month.slice(0, 7)}-${String(daysInMonth(month)).padStart(2, '0')}`

  const [drafts, unbilled, stale] = await Promise.all([
    admin.from('invoices').select('id, invoice_number, status, total_amount, total_amount_inr')
      .in('status', ['draft', 'reviewed']).eq('billing_period_start', month),
    unbilledTasks(admin, { from: month, to: monthEnd }),
    admin.from('tasks').select('id, task_number, title, task_date, billing_amount_inr')
      .is('deleted_at', null).eq('status', 'delivered').not('is_billable', 'is', false)
      .lte('task_date', addDays(today, -7)).gte('task_date', addDays(month, -60)).limit(500),
  ])
  if (drafts.error) return { ok: false as const, error: `invoices: ${drafts.error.message}` }
  if (!unbilled.ok) return { ok: false as const, error: `unbilled: ${unbilled.error}` }
  if (stale.error) return { ok: false as const, error: `delivered: ${stale.error.message}` }

  const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
  const draftRows = (drafts.data || []) as any[]
  const draftTotal = draftRows.reduce((s, d) => s + Number(d.total_amount_inr ?? d.total_amount ?? 0), 0)
  const staleRows = (stale.data || []) as any[]
  const staleTotal = staleRows.reduce((s, t) => s + Number(t.billing_amount_inr ?? 0), 0)
  const notOnInvoice = unbilled.unbilled.filter(t => t.status === 'done')

  const parts = [
    draftRows.length && `${draftRows.length} draft invoice${draftRows.length === 1 ? '' : 's'} to review and send (${inr(draftTotal)})`,
    notOnInvoice.length && `${notOnInvoice.length} done task${notOnInvoice.length === 1 ? '' : 's'} on no invoice (${inr(notOnInvoice.reduce((s, t) => s + t.amount_inr, 0))})`,
    staleRows.length && `${staleRows.length} delivered over a week ago, not marked done (${inr(staleTotal)})`,
  ].filter(Boolean) as string[]
  if (parts.length) {
    await notifyAdmins({
      type: 'autopilot_billing',
      title: `Month-end billing for ${monthLabel(month)}: ${parts.length} thing${parts.length === 1 ? '' : 's'} to close`,
      message: parts.join(' · '),
      link: '/dashboard/invoices',
      sourceKey: `autopilot_billing:${today}`,
    })
  }
  return {
    ok: true as const, month, drafts: draftRows.length, draftTotal, notOnInvoice: notOnInvoice.length,
    deliveredNotDone: staleRows.length,
  }
}
