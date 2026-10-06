/**
 * Per-person work measures for ownership — what each participant handled,
 * planned or recorded in a period, with the ITEMS behind every number.
 *
 * Three per-person bases sit beside `entries` (cash-book rows):
 *
 *   clients_handled — the clients a person handles (client_handlers, dated).
 *                     units  = clients with work dated in the period
 *                     amount = billing of those clients' tasks in the period
 *   planned         — the tasks a person planned (who added the calendar item,
 *                     else who created the request; recorded from 2026-10-04).
 *                     units  = planned tasks dated in the period
 *                     amount = their billing
 *   activities      — pieces of work a person recorded, from the SOURCE tables
 *                     (never the activity log, which misses most writes).
 *                     units  = items; no money
 *
 * A ₹ rule pays rate × units; a % rule pays % × amount. Every number carries
 * its items so a preview or payslip line can show exactly what was counted.
 * Pure attribution functions are exported for tests; loaders are best-effort.
 */

import type { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll } from '@/lib/supabase/server'
import { periodWindow } from './entry-count'
import type { OwnershipPeriod } from './types'

type Admin = ReturnType<typeof createAdminClient>

export interface MeasureItem {
  /** What it was — "INV-2609-015 · Sea Star", "#2045 Thai prawns". */
  label: string
  /** YYYY-MM-DD. */
  date: string
  /** Money attributed through this item, when the basis measures money. */
  amountInr?: number
}

export interface PersonMeasure {
  units: number
  amountInr: number
  items: MeasureItem[]
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const empty = (ids: string[]) => Object.fromEntries(ids.map(id => [id, { units: 0, amountInr: 0, items: [] as MeasureItem[] }])) as Record<string, PersonMeasure>

// ── Activities catalogue ─────────────────────────────────────────────────────

export { ACTIVITY_KINDS, isActivityKind, type ActivityKind } from './activity-kinds'
import { isActivityKind } from './activity-kinds'

// ── Pure attribution ─────────────────────────────────────────────────────────

export interface TaskRow {
  id: string; task_number: number | null; title: string | null; task_date: string
  billing_amount_inr: number | null; client_id: string | null; status: string | null
}
export interface HandlerRow { client_id: string; employee_id: string; effective_from: string; effective_to: string | null }

/** The handler of a client on a date — the dated row covering it. */
export function handlerOn(handlers: HandlerRow[], clientId: string, date: string): string | null {
  const h = handlers.find(x => x.client_id === clientId && x.effective_from <= date && (!x.effective_to || x.effective_to >= date))
  return h?.employee_id ?? null
}

/** Clients handled: billing of each task goes to that client's handler on the task date. */
export function attributeClientHandling(
  tasks: TaskRow[], handlers: HandlerRow[], clientNames: Map<string, string>, employeeIds: string[],
): Record<string, PersonMeasure> {
  const out = empty(employeeIds)
  const perClient = new Map<string, { employeeId: string; clientId: string; amount: number; worked: boolean; first: string }>()
  for (const t of tasks) {
    if (!t.client_id) continue
    const who = handlerOn(handlers, t.client_id, t.task_date)
    if (!who || !out[who]) continue
    const key = `${who}|${t.client_id}`
    const c = perClient.get(key) ?? { employeeId: who, clientId: t.client_id, amount: 0, worked: false, first: t.task_date }
    c.amount += Number(t.billing_amount_inr || 0)
    if (t.status !== 'cancelled') c.worked = true
    if (t.task_date < c.first) c.first = t.task_date
    perClient.set(key, c)
  }
  for (const c of perClient.values()) {
    const m = out[c.employeeId]
    if (c.worked) m.units += 1
    m.amountInr += c.amount
    m.items.push({ label: clientNames.get(c.clientId) ?? 'Client', date: c.first, amountInr: r2(c.amount) })
  }
  for (const m of Object.values(out)) { m.amountInr = r2(m.amountInr); m.items.sort((a, b) => (b.amountInr ?? 0) - (a.amountInr ?? 0)) }
  return out
}

/** Who planned each task: the calendar item's creator, else the request's creator. */
export function plannerOf(
  taskId: string,
  items: { task_id: string | null; request_id: string | null; created_by: string | null }[],
  requests: { id: string; promoted_task_id: string | null; created_by: string | null }[],
): string | null {
  const req = requests.find(r => r.promoted_task_id === taskId)
  const item = items.find(i => i.task_id === taskId) ?? (req ? items.find(i => i.request_id === req.id) : undefined)
  return item?.created_by ?? req?.created_by ?? null
}

export function attributePlanned(
  tasks: TaskRow[],
  items: { task_id: string | null; request_id: string | null; created_by: string | null }[],
  requests: { id: string; promoted_task_id: string | null; created_by: string | null }[],
  employeeIds: string[],
): Record<string, PersonMeasure> {
  const out = empty(employeeIds)
  for (const t of tasks) {
    if (t.status === 'cancelled') continue
    const who = plannerOf(t.id, items, requests)
    if (!who || !out[who]) continue
    const amt = Number(t.billing_amount_inr || 0)
    out[who].units += 1
    out[who].amountInr += amt
    out[who].items.push({ label: `#${t.task_number ?? '—'} ${t.title ?? ''}`.trim(), date: t.task_date, amountInr: r2(amt) })
  }
  for (const m of Object.values(out)) { m.amountInr = r2(m.amountInr); m.items.sort((a, b) => a.date.localeCompare(b.date)) }
  return out
}

// ── Loaders ──────────────────────────────────────────────────────────────────

async function tasksInPeriod(admin: Admin, period: OwnershipPeriod): Promise<TaskRow[]> {
  const { data } = await fetchAll(admin.from('tasks')
    .select('id, task_number, title, task_date, billing_amount_inr, client_id, status')
    .gte('task_date', period.start).lte('task_date', period.end).is('deleted_at', null)
    .order('task_date', { ascending: true }).order('id', { ascending: true }))
  return (data ?? []) as TaskRow[]
}

export async function loadClientHandling(admin: Admin, period: OwnershipPeriod, employeeIds: string[]): Promise<Record<string, PersonMeasure>> {
  if (!employeeIds.length) return {}
  try {
    const [{ data: handlers }, tasks, { data: clients }] = await Promise.all([
      admin.from('client_handlers').select('client_id, employee_id, effective_from, effective_to')
        .lte('effective_from', period.end).or(`effective_to.is.null,effective_to.gte.${period.start}`),
      tasksInPeriod(admin, period),
      admin.from('clients').select('id, name'),
    ])
    const names = new Map(((clients ?? []) as { id: string; name: string }[]).map(c => [c.id, c.name]))
    return attributeClientHandling(tasks, (handlers ?? []) as HandlerRow[], names, employeeIds)
  } catch { return empty(employeeIds) }
}

export async function loadPlanned(admin: Admin, period: OwnershipPeriod, employeeIds: string[]): Promise<Record<string, PersonMeasure>> {
  if (!employeeIds.length) return {}
  try {
    const tasks = await tasksInPeriod(admin, period)
    const ids = tasks.map(t => t.id)
    const requests: { id: string; promoted_task_id: string | null; created_by: string | null }[] = []
    const items: { task_id: string | null; request_id: string | null; created_by: string | null }[] = []
    for (let i = 0; i < ids.length; i += 200) {
      const part = ids.slice(i, i + 200)
      const [r, it] = await Promise.all([
        admin.from('task_requests').select('id, promoted_task_id, created_by').in('promoted_task_id', part),
        admin.from('social_calendar_items').select('task_id, request_id, created_by').in('task_id', part),
      ])
      requests.push(...((r.data ?? []) as typeof requests)); items.push(...((it.data ?? []) as typeof items))
    }
    const reqIds = requests.map(r => r.id)
    for (let i = 0; i < reqIds.length; i += 200) {
      const { data } = await admin.from('social_calendar_items').select('task_id, request_id, created_by').in('request_id', reqIds.slice(i, i + 200))
      items.push(...((data ?? []) as typeof items))
    }
    return attributePlanned(tasks, items, requests, employeeIds)
  } catch { return empty(employeeIds) }
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

/** Count recorded work of the chosen kinds, per person, with every item listed. */
export async function loadActivities(
  admin: Admin, period: OwnershipPeriod, employeeIds: string[], kinds: string[],
): Promise<Record<string, PersonMeasure>> {
  const out = empty(employeeIds)
  if (!employeeIds.length) return out
  const { fromIso, toIso } = periodWindow(period)
  const day = (iso: string) => new Date(new Date(iso).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10)
  const push = (who: string | null, label: string, at: string) => {
    if (!who || !out[who]) return
    out[who].units += 1
    out[who].items.push({ label, date: day(at) })
  }
  for (const kind of kinds.filter(isActivityKind)) {
    try {
      if (kind === 'cashbook_entry') {
        const { data } = await fetchAll(admin.from('cashbook_entries')
          .select('created_by, created_at, type, amount_inr, description, entry_date')
          .is('deleted_at', null).is('transfer_ref', null).in('created_by', employeeIds)
          .gte('created_at', fromIso).lt('created_at', toIso).order('created_at', { ascending: true }))
        for (const r of (data ?? []) as Record<string, string | number>[]) {
          push(r.created_by as string, `${r.type === 'inflow' ? 'In' : 'Out'} ${inr(Number(r.amount_inr || 0))} · ${String(r.description ?? '').slice(0, 60)}`, r.created_at as string)
        }
      } else if (kind === 'invoice_followup') {
        const { data } = await admin.from('invoice_followups')
          .select('created_by, created_at, note, outcome, invoice:invoices(invoice_number, client:clients(name))')
          .in('created_by', employeeIds).gte('created_at', fromIso).lt('created_at', toIso)
        for (const r of (data ?? []) as Record<string, unknown>[]) {
          const inv = (Array.isArray(r.invoice) ? r.invoice[0] : r.invoice) as { invoice_number?: string; client?: { name?: string } } | null
          push(r.created_by as string, `${inv?.invoice_number ?? 'Invoice'} · ${inv?.client?.name ?? ''} · ${String(r.outcome ?? r.note ?? '').slice(0, 40)}`, r.created_at as string)
        }
      } else if (kind === 'request_created') {
        const { data } = await admin.from('task_requests').select('created_by, created_at, ref_no, title')
          .in('created_by', employeeIds).gte('created_at', fromIso).lt('created_at', toIso)
        for (const r of (data ?? []) as Record<string, unknown>[]) push(r.created_by as string, `REQ-${String(r.ref_no ?? 0).padStart(4, '0')} ${r.title ?? ''}`, r.created_at as string)
      } else if (kind === 'plan_item') {
        const { data } = await admin.from('social_calendar_items').select('created_by, created_at, title, scheduled_date')
          .in('created_by', employeeIds).gte('created_at', fromIso).lt('created_at', toIso)
        for (const r of (data ?? []) as Record<string, unknown>[]) push(r.created_by as string, `${r.title ?? 'Plan item'}${r.scheduled_date ? ` · for ${r.scheduled_date}` : ''}`, r.created_at as string)
      } else if (kind === 'social_post') {
        const { data } = await admin.from('social_posts').select('created_by, created_at, caption, content_type')
          .is('deleted_at', null).in('created_by', employeeIds).gte('created_at', fromIso).lt('created_at', toIso)
        for (const r of (data ?? []) as Record<string, unknown>[]) push(r.created_by as string, `${r.content_type ?? 'Post'} · ${String(r.caption ?? '').slice(0, 50)}`, r.created_at as string)
      } else if (kind === 'field_place') {
        const { data } = await admin.from('field_places').select('created_by, created_at, name, area')
          .in('created_by', employeeIds).gte('created_at', fromIso).lt('created_at', toIso)
        for (const r of (data ?? []) as Record<string, unknown>[]) push(r.created_by as string, `${r.name ?? 'Place'}${r.area ? ` · ${r.area}` : ''}`, r.created_at as string)
      }
    } catch { /* one unreadable kind never stops the others */ }
  }
  for (const m of Object.values(out)) m.items.sort((a, b) => a.date.localeCompare(b.date))
  return out
}
