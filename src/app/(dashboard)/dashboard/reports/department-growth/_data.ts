/**
 * Shared window loader for the department pages.
 *
 * The card index and each department's own page must never disagree about a
 * department's revenue, so they read through ONE loader rather than each
 * assembling the same joins. A card that says ₹12,029 linking to a page that
 * says something else destroys trust in both.
 *
 * Server-only: called from Server Components, returns plain data plus one
 * helper for building a department's monthly series.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAll, fetchAllIn } from '@/lib/supabase/server'
import { monthRange } from '@/lib/finance/pnl'
import { lastDayOfMonthISO, todayISO } from '@/lib/utils/local-date'
import { UNASSIGNED_DEPARTMENT_ID } from '@/lib/finance/department-pnl'
import type { DepartmentMonthPoint } from '@/lib/finance/department-trend'
import type { ReportRange } from '@/lib/finance/report-range'

export interface DeptTask {
  id: string
  billingInr: number
  serviceId: string | null
  clientId: string | null
  taskDate: string
  departmentId: string
}

export interface DeptScore {
  taskId: string
  employeeId: string | null
  earningsInr: number
  departmentId: string
  month: string
}

export interface DepartmentRef {
  id: string
  label: string
  revenueInr: number
}

/** True when the window's final month has not finished yet. */
export interface PartialMonth {
  active: boolean
  month: string
  daysElapsed: number
  daysInMonth: number
}

export interface DepartmentWindowData {
  /** Whole months, ascending YYYY-MM. */
  months: string[]
  windowStart: string
  windowEnd: string
  /** True when the requested range was widened to month boundaries. */
  snapped: boolean
  partial: PartialMonth
  /** Departments present in the window, ranked by revenue. */
  departments: DepartmentRef[]
  tasks: DeptTask[]
  scores: DeptScore[]
  serviceName: Map<string, string>
  clientName: Map<string, string>
  cqidOf: Map<string, string>
  readFailed: boolean
  labelFor: (departmentId: string) => string
  /** Monthly series for one department, with dormant months present as zeroes. */
  pointsFor: (departmentId: string) => DepartmentMonthPoint[]
}

/**
 * Load everything both department views need for a window.
 *
 * A trend needs WHOLE months — a part-month tail always reads as a collapse
 * next to full bars — so the range is snapped outward before anything is
 * queried, and `partial` reports when the final month is still running.
 */
export async function loadDepartmentWindow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  raw: ReportRange,
): Promise<DepartmentWindowData> {
  const months = monthRange(raw.from.slice(0, 7), raw.to.slice(0, 7))
  const windowStart = `${months[0]}-01`
  const [ly, lm] = months[months.length - 1].split('-').map(Number)
  const windowEnd = lastDayOfMonthISO(ly, lm)
  const snapped = windowStart !== raw.from || windowEnd !== raw.to

  const today = todayISO()
  const lastMonth = months[months.length - 1]
  const partialActive = today.slice(0, 7) === lastMonth && today < windowEnd
  const partial: PartialMonth = {
    active: partialActive,
    month: lastMonth,
    daysElapsed: partialActive ? Number(today.slice(8, 10)) : 0,
    daysInMonth: Number(windowEnd.slice(8, 10)),
  }

  const [{ data: cats }, { data: svcs }] = await Promise.all([
    fetchAll(admin.from('service_categories').select('id, name').order('display_order').order('name')),
    fetchAll(admin.from('services').select('id, name, category_id')),
  ])
  const categoryName = new Map<string, string>()
  for (const c of (cats || []) as { id: string; name: string }[]) categoryName.set(c.id, c.name)
  const serviceCategory = new Map<string, string | null>()
  const serviceName = new Map<string, string>()
  for (const s of (svcs || []) as { id: string; name: string; category_id: string | null }[]) {
    serviceCategory.set(s.id, s.category_id)
    serviceName.set(s.id, s.name)
  }

  const labelFor = (id: string): string =>
    id === UNASSIGNED_DEPARTMENT_ID ? 'Unassigned' : categoryName.get(id) ?? 'Unknown category'

  const departmentOf = (serviceId: string | null): string =>
    serviceId ? serviceCategory.get(serviceId) ?? UNASSIGNED_DEPARTMENT_ID : UNASSIGNED_DEPARTMENT_ID

  const { data: taskRows, error: taskError } = await fetchAll(
    admin.from('tasks')
      .select('id, billing_amount_inr, service_id, client_id, task_date')
      .gte('task_date', windowStart)
      .lte('task_date', windowEnd)
      .is('deleted_at', null),
  )
  const tasks: DeptTask[] = ((taskRows || []) as {
    id: string
    billing_amount_inr: number | null
    service_id: string | null
    client_id: string | null
    task_date: string
  }[]).map(t => ({
    id: t.id,
    billingInr: Number(t.billing_amount_inr || 0),
    serviceId: t.service_id,
    clientId: t.client_id,
    taskDate: t.task_date,
    departmentId: departmentOf(t.service_id),
  }))

  const taskById = new Map(tasks.map(t => [t.id, t]))

  const { data: scoreRows, error: scoreError } = await fetchAllIn(
    (chunk: string[]) => admin.from('contribution_scores')
      .select('task_id, employee_id, earnings_inr').in('task_id', chunk),
    tasks.map(t => t.id),
  )
  const scores: DeptScore[] = []
  for (const s of (scoreRows || []) as {
    task_id: string | null; employee_id: string | null; earnings_inr: number | null
  }[]) {
    const t = s.task_id ? taskById.get(s.task_id) : undefined
    if (!t) continue      // orphan score — no task, so no department
    scores.push({
      taskId: t.id,
      employeeId: s.employee_id,
      earningsInr: Number(s.earnings_inr || 0),
      departmentId: t.departmentId,
      month: t.taskDate.slice(0, 7),
    })
  }

  // Names for the detail view. CQID only — employee names must never render.
  const [{ data: clientRows }, { data: empRows }] = await Promise.all([
    fetchAllIn(
      (chunk: string[]) => admin.from('clients').select('id, name').in('id', chunk),
      tasks.map(t => t.clientId).filter((v): v is string => Boolean(v)),
    ),
    fetchAllIn(
      (chunk: string[]) => admin.from('employees').select('id, cqid').in('id', chunk),
      scores.map(s => s.employeeId).filter((v): v is string => Boolean(v)),
    ),
  ])
  const clientName = new Map<string, string>()
  for (const c of (clientRows || []) as { id: string; name: string | null }[]) {
    clientName.set(c.id, c.name || 'Unnamed client')
  }
  const cqidOf = new Map<string, string>()
  for (const e of (empRows || []) as { id: string; cqid: string | null }[]) {
    cqidOf.set(e.id, e.cqid || '—')
  }

  const revenueByDept = new Map<string, number>()
  for (const t of tasks) {
    revenueByDept.set(t.departmentId, (revenueByDept.get(t.departmentId) ?? 0) + t.billingInr)
  }
  const departments: DepartmentRef[] = [...revenueByDept.entries()]
    .map(([id, revenueInr]) => ({ id, label: labelFor(id), revenueInr: Math.round(revenueInr * 100) / 100 }))
    .sort((a, b) => b.revenueInr - a.revenueInr)

  const pointsFor = (departmentId: string): DepartmentMonthPoint[] => {
    const rev = new Map<string, number>()
    const count = new Map<string, number>()
    for (const t of tasks) {
      if (t.departmentId !== departmentId) continue
      const m = t.taskDate.slice(0, 7)
      rev.set(m, (rev.get(m) ?? 0) + t.billingInr)
      count.set(m, (count.get(m) ?? 0) + 1)
    }
    const labour = new Map<string, number>()
    for (const s of scores) {
      if (s.departmentId !== departmentId) continue
      labour.set(s.month, (labour.get(s.month) ?? 0) + s.earningsInr)
    }
    // Every month present, dormant ones as zeroes, so a gap reads as a gap.
    return months.map(m => ({
      month: m,
      revenueInr: rev.get(m) ?? 0,
      directLabourInr: labour.get(m) ?? 0,
      taskCount: count.get(m) ?? 0,
    }))
  }

  return {
    months, windowStart, windowEnd, snapped, partial,
    departments, tasks, scores,
    serviceName, clientName, cqidOf,
    readFailed: Boolean(taskError || scoreError),
    labelFor, pointsFor,
  }
}
