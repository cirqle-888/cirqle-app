import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAll, fetchAllIn } from '@/lib/supabase/server'
import { addDaysISO } from '@/lib/utils/local-date'
import { CLIENT_WINDOW_DAYS, type InvoiceLite, type LatestFollowup, type OwnerCheckInput } from './rules'

/**
 * Reads everything the owner check needs, with the service-role client.
 *
 * Server-only. Returns the input plus a list of what could not be read, so a
 * caller can refuse to send an alert built on a partial read instead of
 * reporting a false all-clear.
 */

const OPEN_OR_DRAFT = ['draft', 'reviewed', 'sent', 'partial', 'overdue']

type Embedded = { name: string } | { name: string }[] | null | undefined
const embeddedName = (c: Embedded): string | null => (Array.isArray(c) ? c[0]?.name : c?.name) ?? null

interface InvoiceRow {
  id: string; invoice_number: string; status: string; issue_date: string | null; due_date: string | null
  total_amount_inr: number | null; paid_amount_inr: number | null; client_id: string | null; client: Embedded
}
interface TaskRow { client_id: string | null; task_date: string; billing_amount_inr: number | null }
interface ClientRow { id: string; name: string; is_active: boolean | null }
interface RequestRow { id: string; ref_no: number; title: string; status: string; due_date: string | null; client: Embedded }

export async function loadOwnerCheckInput(
  admin: SupabaseClient,
  today: string,
): Promise<{ input: OwnerCheckInput; errors: string[] }> {
  const errors: string[] = []
  const windowStart = addDaysISO(today, -CLIENT_WINDOW_DAYS)
  const weekAgo = addDaysISO(today, -7)
  const ninetyDaysAgo = addDaysISO(today, -90)

  const [inv, tasks, clients, requests, uncategorised, unreviewed, runs] = await Promise.all([
    fetchAll(admin.from('invoices')
      .select('id, invoice_number, status, issue_date, due_date, total_amount_inr, paid_amount_inr, client_id, client:clients(name)')
      .in('status', OPEN_OR_DRAFT)),
    fetchAll(admin.from('tasks')
      .select('client_id, task_date, billing_amount_inr')
      .is('deleted_at', null)
      .gte('task_date', windowStart)
      .lte('task_date', today)),
    fetchAll(admin.from('clients').select('id, name, is_active')),
    fetchAll(admin.from('task_requests')
      .select('id, ref_no, title, status, due_date, client:clients(name)')
      .is('archived_at', null)
      .lt('due_date', today)),
    admin.from('cashbook_entries').select('id', { count: 'exact', head: true })
      .is('deleted_at', null).is('category_id', null),
    admin.from('cashbook_entries').select('id', { count: 'exact', head: true })
      .is('deleted_at', null).eq('is_reviewed', false).gte('entry_date', ninetyDaysAgo),
    admin.from('cron_runs').select('cron_name, ran_at, ok, error').gte('ran_at', `${weekAgo}T00:00:00Z`)
      .order('ran_at', { ascending: false }).limit(500),
  ])

  if (inv.error) errors.push(`invoices: ${inv.error.message ?? inv.error}`)
  if (tasks.error) errors.push(`tasks: ${tasks.error.message ?? tasks.error}`)
  if (clients.error) errors.push(`clients: ${clients.error.message ?? clients.error}`)
  if (requests.error) errors.push(`requests: ${requests.error.message ?? requests.error}`)
  if (uncategorised.error) errors.push(`cash book: ${uncategorised.error.message}`)
  if (unreviewed.error) errors.push(`cash book review: ${unreviewed.error.message}`)
  if (runs.error) errors.push(`automation log: ${runs.error.message}`)

  const invoices: InvoiceLite[] = ((inv.data || []) as InvoiceRow[]).map(r => ({
    id: r.id,
    invoice_number: r.invoice_number,
    status: r.status,
    issue_date: r.issue_date,
    due_date: r.due_date,
    total_inr: Number(r.total_amount_inr) || 0,
    paid_inr: Number(r.paid_amount_inr) || 0,
    client_id: r.client_id,
    client_name: embeddedName(r.client),
  }))

  // Latest follow-up per open invoice.
  const sentIds = invoices.filter(i => i.status !== 'draft' && i.status !== 'reviewed').map(i => i.id)
  const fu = await fetchAllIn(
    ids => admin.from('invoice_followups')
      .select('invoice_id, promised_date, next_followup_date, created_at')
      .in('invoice_id', ids),
    sentIds,
  )
  if (fu.error) errors.push(`follow-ups: ${fu.error.message ?? fu.error}`)
  const latestFollowups = new Map<string, LatestFollowup>()
  for (const r of (fu.data || []) as (LatestFollowup & { invoice_id: string })[]) {
    const cur = latestFollowups.get(r.invoice_id)
    if (!cur || r.created_at > cur.created_at) latestFollowups.set(r.invoice_id, r)
  }

  return {
    errors,
    input: {
      invoices,
      latestFollowups,
      tasks: ((tasks.data || []) as TaskRow[]).map(t => ({ client_id: t.client_id, task_date: t.task_date, value_inr: Number(t.billing_amount_inr) || 0 })),
      clients: ((clients.data || []) as ClientRow[]).map(c => ({ id: c.id, name: c.name, is_active: c.is_active !== false })),
      requests: ((requests.data || []) as RequestRow[]).map(r => ({
        id: r.id, ref_no: r.ref_no, title: r.title, status: r.status, due_date: r.due_date, client_name: embeddedName(r.client),
      })),
      cashbook: { uncategorised: uncategorised.count ?? 0, unreviewed: unreviewed.count ?? 0 },
      cronRuns: (runs.data || []) as OwnerCheckInput['cronRuns'],
    },
  }
}
