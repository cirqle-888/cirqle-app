/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Give unassigned requests to the person who usually does the client's work,
 * so they land in that person's My Work. Starting the card there creates the
 * task (my-work/actions.ts), priced from the Pricing Matrix as before.
 *
 * Only requests that nobody has touched: open, not started, no assignee, not
 * a complimentary checklist item. The write is guarded on "still unassigned",
 * so a person assigning at the same moment always wins.
 */
import type { Admin } from '@/lib/mcp/shared'
import { fetchAll } from '@/lib/supabase/server'
import { logRequestActivity } from '@/lib/requests/core'
import { createNotification, notifyAdmins } from '@/lib/notifications/create'
import { addDays } from './social-rules'
import { HISTORY_DAYS, pickAssignee, type AssignHistoryRow } from './assign-rules'

const WAITING = ['submitted', 'under_review', 'approved']
/** Older requests that nobody picked up are a person's call (stale, done elsewhere): never handed out in bulk. */
export const RECENT_DAYS = 14
const refLabel = (n: number | null | undefined) => `REQ-${String(n ?? 0).padStart(4, '0')}`

export async function assignWaitingRequests(admin: Admin, today: string, opts: { runKey?: string } = {}) {
  // `kind` arrived with a later migration; without it every row is a plain request.
  const read = (cols: string) => admin.from('task_requests').select(cols)
    .in('status', WAITING).is('assigned_employee_id', null).is('promoted_task_id', null).is('archived_at', null)
    .not('client_id', 'is', null).gte('created_at', `${addDays(today, -RECENT_DAYS)}T00:00:00+05:30`).limit(300)
  let { data: reqs, error } = await read('id, ref_no, title, client_id, service_id, due_date, kind, client:clients(name)')
  if (error && /kind/.test(error.message)) ({ data: reqs, error } = await read('id, ref_no, title, client_id, service_id, due_date, client:clients(name)'))
  if (error) return { ok: false as const, error: `requests: ${error.message}` }
  const waiting = ((reqs || []) as any[]).filter(r => r.kind !== 'checklist')
  if (!waiting.length) return { ok: true as const, assigned: 0, leftForPerson: 0 }

  const since = addDays(today, -HISTORY_DAYS)
  const clientIds = [...new Set(waiting.map(r => r.client_id as string))]
  const tasks = await fetchAll(admin.from('tasks').select('id, client_id, service_id')
    .in('client_id', clientIds).is('deleted_at', null).neq('status', 'cancelled').gte('task_date', since))
  if (tasks.error) return { ok: false as const, error: `tasks: ${tasks.error.message ?? tasks.error}` }
  const taskRows = (tasks.data || []) as any[]
  const taskById = new Map(taskRows.map(t => [t.id as string, t]))
  const history: AssignHistoryRow[] = []
  for (let i = 0; i < taskRows.length; i += 200) {
    const { data, error: e2 } = await admin.from('task_assignments').select('task_id, employee_id').in('task_id', taskRows.slice(i, i + 200).map(t => t.id))
    if (e2) return { ok: false as const, error: `assignments: ${e2.message}` }
    for (const a of (data || []) as any[]) {
      const t = taskById.get(a.task_id)
      if (t) history.push({ client_id: t.client_id, service_id: t.service_id, employee_id: a.employee_id })
    }
  }
  const { data: emps } = await admin.from('employees').select('id, name, is_active, is_archived')
  const empName = new Map(((emps || []) as any[]).map(e => [e.id as string, (e.name as string) || 'Someone']))
  const active = new Set(((emps || []) as any[]).filter(e => e.is_active && !e.is_archived).map(e => e.id as string))

  const assigned: { ref: string; title: string; client: string; person: string }[] = []
  const left: { ref: string; client: string }[] = []
  for (const r of waiting) {
    const pick = pickAssignee({ id: r.id, client_id: r.client_id, service_id: r.service_id }, history, active)
    const client = r.client?.name || 'client'
    if (!pick) { left.push({ ref: refLabel(r.ref_no), client }); continue }
    const { data: claimed, error: upErr } = await admin.from('task_requests')
      .update({ assigned_employee_id: pick.employeeId, updated_at: new Date().toISOString() })
      .eq('id', r.id).is('assigned_employee_id', null).select('id')
    if (upErr || !claimed?.length) continue
    const person = empName.get(pick.employeeId) || 'Someone'
    await logRequestActivity(admin, {
      requestId: r.id, actorType: 'system', actorLabel: 'Autopilot', action: 'assigned', visibility: 'internal',
      detail: { employee_id: pick.employeeId, employee_name: person, reason: `does ${pick.sharePct}% of ${client}'s recent work` },
    })
    await createNotification({
      employeeId: pick.employeeId,
      type: 'request_assigned',
      title: `New work for you: ${refLabel(r.ref_no)} ${r.title}`,
      message: `${client}${r.due_date ? `, due ${r.due_date}` : ''}. It is in your My Work; starting it creates the task.`,
      link: '/dashboard/my-work',
      sourceKey: `autopilot_assigned:${r.id}`,
    })
    assigned.push({ ref: refLabel(r.ref_no), title: r.title, client, person })
  }

  if (assigned.length || left.length) {
    await notifyAdmins({
      type: 'autopilot_requests_assigned',
      title: assigned.length
        ? `Autopilot gave ${assigned.length} request${assigned.length === 1 ? '' : 's'} to designers${left.length ? `, ${left.length} need you` : ''}`
        : `${left.length} request${left.length === 1 ? '' : 's'} need a designer`,
      message: [
        ...assigned.slice(0, 5).map(a => `${a.ref} ${a.client} → ${a.person}`),
        left.length ? `No clear designer: ${left.slice(0, 5).map(l => `${l.ref} ${l.client}`).join(', ')}` : '',
      ].filter(Boolean).join(' · '),
      link: '/dashboard/requests',
      sourceKey: `autopilot_assign:${today}:${opts.runKey || 'am'}`,
    })
  }
  return { ok: true as const, assigned: assigned.length, leftForPerson: left.length }
}
