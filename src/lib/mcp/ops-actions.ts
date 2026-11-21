/* eslint-disable @typescript-eslint/no-explicit-any -- rows from the untyped Supabase admin client; each is narrowed before it leaves this file. */
/**
 * Day-to-day operations for the MCP server: move a task along, find work that
 * was finished but never billed, a one-call business snapshot, leads,
 * quotations and one request in full. Task status runs the SAME follow-ups the
 * Tasks page runs (draft invoices, derived billing, analytics, linked
 * requests), so a change made by an AI leaves the books exactly as a person's
 * change would.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { syncDraftInvoices } from '@/lib/sync/integrity'
import { resyncDerivedForSource } from '@/lib/tasks/derived-billing-sync'
import { invalidateAnalyticsForDates } from '@/lib/analytics/invalidate'
import { syncRequestStatusFromTask } from '@/lib/requests/task-sync'
import { logActivity } from '@/lib/activity/log'
import { OPEN_STATUSES as OPEN_INVOICE_STATUSES, outstandingAmount } from '@/lib/finance/invoice-revenue'

type Admin = SupabaseClient<any, any, any>

/** Statuses an AI may set. Invoiced and paid come only from invoicing. */
export const SETTABLE_TASK_STATUSES = ['pending', 'in_progress', 'delivered', 'done', 'cancelled'] as const
export type SettableTaskStatus = typeof SETTABLE_TASK_STATUSES[number]

/** Requests still waiting for work (the inbox's own list). */
export const OPEN_REQUEST_STATUSES = ['submitted', 'under_review', 'approved', 'started', 'in_progress', 'waiting_for_content', 'revision_requested']

export const parseTaskNumber = (v: number | string) => parseInt(String(v).replace(/^#/, ''), 10)

/** Can a task go from one status to another here? null when it can. */
export function statusChangeProblem(from: string, to: string): string | null {
  if (!(SETTABLE_TASK_STATUSES as readonly string[]).includes(to)) return `"${to}" cannot be set here. Use one of: ${SETTABLE_TASK_STATUSES.join(', ')}.`
  if (from === to) return `It is already ${to}.`
  if (from === 'invoiced' || from === 'paid') return 'It is already invoiced; change it from the invoice instead.'
  return null
}

export async function setTaskStatus(
  admin: Admin, taskNumber: number | string, to: string,
  /** Who moved it, for the activity log. Defaults to the AI connector. */
  by: { actorId?: string | null; via?: string } = {},
) {
  const num = parseTaskNumber(taskNumber)
  if (isNaN(num)) return { ok: false as const, error: 'A numeric task number is required.' }
  const { data: task, error } = await admin.from('tasks')
    .select('id, task_number, title, status, client_id, service_id, task_date, billing_mode')
    .eq('task_number', num).is('deleted_at', null).maybeSingle()
  if (error) return { ok: false as const, error: error.message }
  if (!task) return { ok: false as const, error: `Task #${num} not found.` }
  const t = task as any
  const from = String(t.status)
  const problem = statusChangeProblem(from, to)
  if (problem) return { ok: false as const, error: `#${num}: ${problem}` }
  const { data: moved, error: upErr } = await admin.from('tasks').update({ status: to })
    .eq('id', t.id).eq('status', from).select('id')
  if (upErr) return { ok: false as const, error: upErr.message }
  if (!moved?.length) return { ok: false as const, error: `#${num} changed in the app meanwhile. Nothing was saved.` }

  // The Tasks page's follow-ups, in the same order. Each is best-effort after the save.
  void logActivity({ actorId: by.actorId ?? null, entityType: 'task', entityId: t.id, action: 'status_changed', detail: { title: t.title, from, to, via: by.via ?? 'AI connector' } })
  try { await syncDraftInvoices(t.id) } catch { /* the nightly integrity check catches up */ }
  try {
    await resyncDerivedForSource(admin as never, { clientId: t.client_id, serviceId: t.service_id, taskDate: t.task_date, billingMode: t.billing_mode }, `task ${t.title} → ${to}`, null)
  } catch { /* derived billing is additive */ }
  try { await invalidateAnalyticsForDates([t.task_date]) } catch { /* 24h TTL applies */ }
  void syncRequestStatusFromTask(t.id, to).catch(() => {})
  return { ok: true as const, task_number: num, title: t.title as string, from, to }
}

/** Finished, billable work with no invoice line yet. Package work is listed apart. */
export async function unbilledTasks(admin: Admin, p: { clientId?: string | null; from?: string; to?: string }) {
  let q = admin.from('tasks')
    .select('id, task_number, title, status, task_date, billing_amount_inr, is_billable, package_id, client:clients(name), service:services!tasks_service_id_fkey(name)')
    .is('deleted_at', null).in('status', ['delivered', 'done']).not('is_billable', 'is', false)
    .order('task_date').limit(500)
  if (p.clientId) q = q.eq('client_id', p.clientId)
  if (p.from) q = q.gte('task_date', p.from)
  if (p.to) q = q.lte('task_date', p.to)
  const { data, error } = await q
  if (error) return { ok: false as const, error: error.message }
  const rows = (data || []) as any[]
  const billed = new Set<string>()
  for (let i = 0; i < rows.length; i += 150) {
    const ids = rows.slice(i, i + 150).map(r => r.id)
    const { data: lines } = await admin.from('invoice_items').select('task_id').in('task_id', ids)
    for (const l of (lines || []) as any[]) if (l.task_id) billed.add(l.task_id)
  }
  const open = rows.filter(r => !billed.has(r.id)).map(r => ({
    task_number: r.task_number, title: r.title, status: r.status, task_date: r.task_date,
    amount_inr: Number(r.billing_amount_inr ?? 0), client: r.client?.name ?? null, service: r.service?.name ?? null,
    in_package: !!r.package_id,
  }))
  const unbilled = open.filter(r => !r.in_package)
  return {
    ok: true as const,
    unbilled, package_work: open.filter(r => r.in_package),
    total_inr: unbilled.reduce((s, r) => s + r.amount_inr, 0),
  }
}

/** One call for "how are we doing today?". */
export async function businessSnapshot(admin: Admin, today: string) {
  const weekAhead = new Date(`${today}T00:00:00`); weekAhead.setDate(weekAhead.getDate() + 7)
  const in7 = weekAhead.toLocaleDateString('en-CA')
  const monthStart = `${today.slice(0, 7)}-01`
  const [reqs, tasks, invoices, cash, posts] = await Promise.all([
    admin.from('task_requests').select('status, due_date').is('archived_at', null).in('status', OPEN_REQUEST_STATUSES).limit(2000),
    admin.from('tasks').select('status, task_date').is('deleted_at', null).in('status', ['pending', 'in_progress', 'delivered']).limit(5000),
    admin.from('invoices').select('status, due_date, total_amount, paid_amount, total_amount_inr, paid_amount_inr').in('status', OPEN_INVOICE_STATUSES).limit(5000),
    admin.from('cashbook_entries').select('type, amount_inr').is('deleted_at', null).gte('entry_date', monthStart).lte('entry_date', today).limit(10000),
    admin.from('social_calendar_items').select('status, request_id, scheduled_date').gte('scheduled_date', today).lte('scheduled_date', in7).neq('status', 'cancelled').limit(2000),
  ])
  const byStatus = (rows: any[] | null) => (rows || []).reduce((m: Record<string, number>, r: any) => { m[r.status] = (m[r.status] || 0) + 1; return m }, {})
  const reqRows = (reqs.data || []) as any[]
  const invRows = (invoices.data || []) as any[]
  const cashRows = (cash.data || []) as any[]
  const postRows = (posts.data || []) as any[]
  const inflow = cashRows.filter(e => e.type === 'inflow').reduce((s, e) => s + Number(e.amount_inr || 0), 0)
  const outflow = cashRows.filter(e => e.type !== 'inflow').reduce((s, e) => s + Number(e.amount_inr || 0), 0)
  return {
    today,
    requests: { open: reqRows.length, overdue: reqRows.filter(r => r.due_date && r.due_date < today).length, by_status: byStatus(reqRows) },
    tasks: { by_status: byStatus(tasks.data as any[]) },
    invoices: {
      open: invRows.length,
      outstanding_inr: invRows.reduce((s, i) => s + outstandingAmount(i), 0),
      overdue: invRows.filter(i => i.status === 'overdue' || (i.due_date && i.due_date < today)).length,
    },
    cash_this_month: { from: monthStart, to: today, inflow_inr: inflow, outflow_inr: outflow, net_inr: inflow - outflow },
    posts_next_7_days: {
      total: postRows.length,
      not_sent_to_requests: postRows.filter(p => p.status === 'planned' && !p.request_id).length,
    },
    errors: [reqs, tasks, invoices, cash, posts].map(r => r.error?.message).filter(Boolean),
  }
}

export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'won', 'lost'] as const

export async function updateLead(admin: Admin, leadId: string, p: { status?: string; note?: string }) {
  const { data: lead, error } = await admin.from('leads').select('id, status, notes, full_name, first_contacted_at').eq('id', leadId).maybeSingle()
  if (error) return { ok: false as const, error: error.message }
  if (!lead) return { ok: false as const, error: 'No lead with that id.' }
  const l = lead as any
  const u: Record<string, unknown> = {}
  if (p.status) {
    if (!(LEAD_STATUSES as readonly string[]).includes(p.status)) return { ok: false as const, error: `Status must be one of: ${LEAD_STATUSES.join(', ')}.` }
    u.status = p.status
    if (p.status === 'contacted' && !l.first_contacted_at) u.first_contacted_at = new Date().toISOString()
  }
  const note = (p.note || '').trim()
  if (note) {
    const stamp = new Date().toLocaleDateString('en-CA')
    u.notes = [l.notes?.trim(), `${stamp}: ${note}`].filter(Boolean).join('\n')
  }
  if (!Object.keys(u).length) return { ok: false as const, error: 'Nothing to change.' }
  const { error: upErr } = await admin.from('leads').update(u).eq('id', leadId)
  if (upErr) return { ok: false as const, error: upErr.message }
  return { ok: true as const, id: leadId, name: l.full_name as string | null, status: (u.status as string) ?? l.status }
}
