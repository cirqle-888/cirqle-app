/**
 * Loads one month of a department's work for the Team Work Report. Server
 * only (service role); the decisions live in team-work.ts.
 *
 * Reads only what the two months need: requests finished in either month or
 * still open, finished tasks dated in either month, and the month's calendar.
 */
import type { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll } from '@/lib/supabase/server'
import { departmentsByClient } from '@/lib/scope/department-clients'
import {
  buildTeamWorkReport, previousMonth, DONE_REQUEST, DONE_TASK, OPEN_REQUEST, WITH_CLIENT_REQUEST,
  type TeamWorkReport,
} from './team-work'

type Admin = ReturnType<typeof createAdminClient>

export interface DepartmentOption { id: string; name: string }

const monthStart = (m: string) => `${m}-01`
function monthEnd(m: string): string {
  const [y, mo] = m.split('-').map(Number)
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10)
}
function nextMonthStart(m: string): string {
  const [y, mo] = m.split('-').map(Number)
  return mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`
}

export async function loadDepartments(admin: Admin): Promise<DepartmentOption[]> {
  const { data } = await admin.from('service_categories').select('id, name').order('name')
  return ((data || []) as DepartmentOption[])
}

export async function loadTeamWorkReport(
  admin: Admin,
  month: string,
  department: DepartmentOption,
  departments: readonly DepartmentOption[],
): Promise<TeamWorkReport> {
  const prev = previousMonth(month)
  const from = monthStart(prev)
  const toExclusive = nextMonthStart(month)

  const [services, clients, pricing, employees, finishedReqs, liveReqs, tasks, calendars] = await Promise.all([
    fetchAll(admin.from('services').select('id, name, category_id')),
    fetchAll(admin.from('clients').select('id, name, department_id, is_active')),
    fetchAll(admin.from('client_service_pricing').select('client_id, service_id').eq('is_active', true)),
    fetchAll(admin.from('employees').select('id, cqid')),
    fetchAll(admin.from('task_requests')
      .select('id, client_id, service_id, status, status_updated_at, assigned_employee_id, promoted_task_id, title')
      .eq('status', DONE_REQUEST).gte('status_updated_at', from).lt('status_updated_at', toExclusive)),
    fetchAll(admin.from('task_requests')
      .select('id, client_id, service_id, status, status_updated_at, assigned_employee_id, promoted_task_id, title')
      .in('status', [...OPEN_REQUEST, WITH_CLIENT_REQUEST])),
    fetchAll(admin.from('tasks')
      .select('id, client_id, service_id, status, task_date, quantity, title, assignments:task_assignments(employee_id)')
      .in('status', [...DONE_TASK]).is('deleted_at', null)
      .gte('task_date', from).lte('task_date', monthEnd(month))),
    fetchAll(admin.from('social_calendars').select('id, client_id')),
  ])
  const failed = [services, clients, pricing, employees, finishedReqs, liveReqs, tasks, calendars].find(r => r.error)
  if (failed) throw new Error('Could not load the team work report.')

  // A promoted request's task can be dated before the request was finished,
  // so the finished-request list alone cannot tell which tasks to skip: ask
  // for every request pointing at one of these tasks.
  const taskIds = (tasks.data as { id: string }[]).map(t => t.id)
  const promotedRows: { promoted_task_id: string }[] = []
  for (let i = 0; i < taskIds.length; i += 200) {
    const { data } = await admin.from('task_requests').select('promoted_task_id').in('promoted_task_id', taskIds.slice(i, i + 200))
    promotedRows.push(...((data || []) as { promoted_task_id: string }[]))
  }

  const calendarClient = new Map((calendars.data as { id: string; client_id: string }[]).map(c => [c.id, c.client_id]))
  const items: { calendar_id: string; service_id: string | null; status: string; scheduled_date: string | null; posted_at: string | null }[] = []
  {
    // Scheduled in the month, or posted in it (a post can go out a day late).
    const [sched, posted] = await Promise.all([
      fetchAll(admin.from('social_calendar_items')
        .select('calendar_id, service_id, status, scheduled_date, posted_at')
        .gte('scheduled_date', monthStart(month)).lte('scheduled_date', monthEnd(month))),
      fetchAll(admin.from('social_calendar_items')
        .select('calendar_id, service_id, status, scheduled_date, posted_at')
        .gte('posted_at', monthStart(month)).lt('posted_at', toExclusive)
        .or(`scheduled_date.lt.${monthStart(month)},scheduled_date.gt.${monthEnd(month)}`)),
    ])
    // A database without the posting columns yet simply reports nothing posted.
    if (!sched.error) items.push(...(sched.data as typeof items))
    if (!posted.error) items.push(...(posted.data as typeof items))
  }

  const serviceRows = services.data as { id: string; name: string; category_id: string | null }[]
  const serviceDepartment = new Map(serviceRows.map(s => [s.id, s.category_id]))
  const activeClients = (clients.data as { id: string; name: string; department_id: string | null; is_active: boolean }[])
  const clientDepartments = departmentsByClient(
    activeClients.filter(c => c.is_active),
    pricing.data as { client_id: string | null; service_id: string | null }[],
    serviceDepartment,
  )
  const socialDept = departments.find(d => /social/i.test(d.name)) ?? null

  // Open / with-client is "as of today", so it is only meaningful for the
  // month we are in. A past month's report shows what was delivered and
  // planned, not today's queue.
  const isCurrentMonth = month === new Date().toISOString().slice(0, 7)
  const requestById = new Map<string, (typeof finishedReqs.data)[number]>()
  for (const r of [...finishedReqs.data, ...(isCurrentMonth ? liveReqs.data : [])]) requestById.set(r.id, r)
  const promoted = new Set(promotedRows.map(r => r.promoted_task_id))

  return buildTeamWorkReport({
    month,
    departmentId: department.id,
    departmentName: department.name,
    serviceDepartment,
    serviceName: new Map(serviceRows.map(s => [s.id, s.name])),
    clientDepartments,
    clientName: new Map(activeClients.map(c => [c.id, c.name])),
    employeeCqid: new Map((employees.data as { id: string; cqid: string }[]).map(e => [e.id, e.cqid])),
    requests: [...requestById.values()],
    tasks: (tasks.data as {
      id: string; client_id: string | null; service_id: string | null; status: string
      task_date: string | null; quantity: number | null; title: string | null; assignments: { employee_id: string }[] | null
    }[])
      // Same rule as the report itself, applied with the full promoted list.
      .filter(t => !promoted.has(t.id))
      .map(t => ({ ...t, assignees: (t.assignments || []).map(a => a.employee_id) })),
    calendarItems: items.map(i => ({
      client_id: calendarClient.get(i.calendar_id) ?? null,
      service_id: i.service_id,
      status: i.status,
      scheduled_date: i.scheduled_date,
      posted_at: i.posted_at,
    })),
    calendarDefaultDepartmentId: socialDept?.id ?? null,
    includeOpen: isCurrentMonth,
  })
}
