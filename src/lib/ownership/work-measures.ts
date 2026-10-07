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
import { periodWindow, allocatedEntryIds, isInvoicePayment } from './entry-count'
import type { OwnershipPeriod } from './types'

type Admin = ReturnType<typeof createAdminClient>

export interface MeasureItem {
  /** What it was — "INV-2609-015 · Sea Star", "#2045 Thai prawns". */
  label: string
  /** YYYY-MM-DD. */
  date: string
  /** Money attributed through this item, when the basis measures money. */
  amountInr?: number
  /** The client (client handling) or task (planning) it was — lets reports
   *  put the reward back on that work. */
  refId?: string
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
  /**
   * Clients chosen on each person's RULE. A person with a list is measured on
   * exactly those clients — and several people may list the same client, each
   * earning on it. A person with no list falls back to the handler table.
   */
  clientsByEmployee: Record<string, string[]> = {},
): Record<string, PersonMeasure> {
  const out = empty(employeeIds)
  const perClient = new Map<string, { employeeId: string; clientId: string; amount: number; worked: boolean; first: string }>()
  const listed = Object.fromEntries(Object.entries(clientsByEmployee).filter(([, l]) => l.length).map(([e, l]) => [e, new Set(l)]))
  for (const t of tasks) {
    if (!t.client_id) continue
    const whoes = new Set<string>()
    for (const [e, set] of Object.entries(listed)) if (set.has(t.client_id)) whoes.add(e)
    const fromTable = handlerOn(handlers, t.client_id, t.task_date)
    if (fromTable && !listed[fromTable]) whoes.add(fromTable)
    for (const who of whoes) {
    if (!out[who]) continue
    const key = `${who}|${t.client_id}`
    const c = perClient.get(key) ?? { employeeId: who, clientId: t.client_id, amount: 0, worked: false, first: t.task_date }
    c.amount += Number(t.billing_amount_inr || 0)
    if (t.status !== 'cancelled') c.worked = true
    if (t.task_date < c.first) c.first = t.task_date
    perClient.set(key, c)
    }
  }
  for (const c of perClient.values()) {
    const m = out[c.employeeId]
    if (c.worked) m.units += 1
    m.amountInr += c.amount
    m.items.push({ label: clientNames.get(c.clientId) ?? 'Client', date: c.first, amountInr: r2(c.amount), refId: c.clientId })
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
    out[who].items.push({ label: `#${t.task_number ?? '—'} ${t.title ?? ''}`.trim(), date: t.task_date, amountInr: r2(amt), refId: t.id })
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

export async function loadClientHandling(admin: Admin, period: OwnershipPeriod, employeeIds: string[], clientsByEmployee: Record<string, string[]> = {}): Promise<Record<string, PersonMeasure>> {
  if (!employeeIds.length) return {}
  try {
    const [{ data: handlers }, tasks, { data: clients }] = await Promise.all([
      admin.from('client_handlers').select('client_id, employee_id, effective_from, effective_to')
        .lte('effective_from', period.end).or(`effective_to.is.null,effective_to.gte.${period.start}`),
      tasksInPeriod(admin, period),
      admin.from('clients').select('id, name'),
    ])
    const names = new Map(((clients ?? []) as { id: string; name: string }[]).map(c => [c.id, c.name]))
    return attributeClientHandling(tasks, (handlers ?? []) as HandlerRow[], names, employeeIds, clientsByEmployee)
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
/** "Task created" events written when My Work starts a request, not by hand. */
export const isAutoCreatedTaskEvent = (detail: { label?: string } | null | undefined): boolean =>
  /auto-created/i.test(detail?.label ?? '')

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
          .select('id, created_by, created_at, type, amount_inr, description, entry_date, invoice_id')
          .is('deleted_at', null).is('transfer_ref', null).in('created_by', employeeIds)
          .gte('created_at', fromIso).lt('created_at', toIso).order('created_at', { ascending: true }))
        const rows = (data ?? []) as Record<string, string | number>[]
        const allocated = await allocatedEntryIds(admin, rows.filter(r => !r.invoice_id).map(r => String(r.id)))
        for (const r of rows) {
          // Invoice payments are rewarded as collections, not as entries.
          if (isInvoicePayment({ invoice_id: r.invoice_id as string | null, allocated: allocated.has(String(r.id)) })) continue
          push(r.created_by as string, `${r.type === 'inflow' ? 'In' : 'Out'} ${inr(Number(r.amount_inr || 0))} · ${String(r.description ?? '').slice(0, 60)}`, r.created_at as string)
        }
      } else if (kind === 'task_created') {
        // "Task created" events name who entered the task. The log can be
        // written from the browser, so each task counts ONCE (first logger),
        // only while it still exists, and only when the event is within
        // 15 minutes of the task's own creation — re-logging an old task, or
        // logging someone else's, earns nothing.
        const { data: events } = await fetchAll(admin.from('activity_logs')
          .select('actor_id, entity_id, created_at, detail')
          .eq('entity_type', 'task').eq('action', 'created').in('actor_id', employeeIds)
          .gte('created_at', fromIso).lt('created_at', toIso).order('created_at', { ascending: true }))
        // Starting assigned work in My Work creates the task automatically and
        // logs it as "created" by whoever pressed Start — work begun, not a
        // task entered — so those events are not counted.
        const evs = ((events ?? []) as { actor_id: string; entity_id: string | null; created_at: string; detail: { label?: string } | null }[])
          .filter(e => !isAutoCreatedTaskEvent(e.detail))
        const ids = [...new Set(evs.map(e => e.entity_id).filter((x): x is string => !!x))]
        const tasks = new Map<string, { task_number: number | null; title: string | null; created_at: string; deleted_at: string | null }>()
        for (let i = 0; i < ids.length; i += 200) {
          const { data } = await admin.from('tasks').select('id, task_number, title, created_at, deleted_at').in('id', ids.slice(i, i + 200))
          for (const t of (data ?? []) as { id: string; task_number: number | null; title: string | null; created_at: string; deleted_at: string | null }[]) tasks.set(t.id, t)
        }
        const counted = new Set<string>()
        for (const e of evs) {
          const t = e.entity_id ? tasks.get(e.entity_id) : undefined
          if (!t || t.deleted_at || counted.has(e.entity_id!)) continue
          if (Math.abs(new Date(e.created_at).getTime() - new Date(t.created_at).getTime()) > 15 * 60_000) continue
          counted.add(e.entity_id!)
          push(e.actor_id, `#${t.task_number ?? '—'} ${t.title ?? ''}`.trim(), e.created_at)
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
