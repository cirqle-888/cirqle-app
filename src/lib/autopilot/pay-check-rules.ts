/**
 * Contribution and pay check: the pure rules. It replaces the monthly habit
 * of scrolling each client's WhatsApp group and Instagram to see who made
 * what, and comparing that with the Contributions page by eye.
 *
 * Evidence, strongest first:
 *   · tasks themselves (finished work with nobody credited)
 *   · a Cirqle person posting a picture, video or file in a client's
 *     WhatsApp group = they delivered a design to that client that day
 *   · a post on the client's own Instagram/Facebook = work went live
 *
 * It only REPORTS. Contributions decide pay, so a person applies the fix on
 * the Contributions page (one click with the suggestion there).
 */
import { addDays, daysInMonth, monthStart } from './social-rules'

export const DONE_STATUSES = new Set(['delivered', 'done', 'invoiced'])
/** WhatsApp message types that carry a design. */
export const DESIGN_TYPES = ['image', 'video', 'document'] as const
/** A delivery on day D belongs to a task dated D-3 … D+1. */
export const TASK_WINDOW = { before: 3, after: 1 }
/** A live post on day D belongs to a task dated D-7 … D+1. */
export const POST_WINDOW = { before: 7, after: 1 }

export interface CheckPeriod { from: string; to: string; month: string }

/** In the first week the previous month is being paid, so check that; later, this month so far. */
export function checkPeriod(today: string): CheckPeriod {
  const day = Number(today.slice(8, 10))
  if (day <= 7) {
    const month = monthStart(addDays(monthStart(today), -1))
    return { from: month, to: `${month.slice(0, 7)}-${String(daysInMonth(month)).padStart(2, '0')}`, month }
  }
  return { from: monthStart(today), to: today, month: monthStart(today) }
}

export interface PcTask {
  id: string
  task_number: number | null
  title: string
  client_id: string | null
  task_date: string | null
  status: string
  contributors: string[]
  assignees: string[]
}
export interface PcDelivery { client_id: string; employee_id: string; day: string; count: number }
export interface PcPost { client_id: string; day: string; permalink: string | null; kind: string | null }

export function tasksWithoutContributors(tasks: PcTask[], period: CheckPeriod): PcTask[] {
  return tasks
    .filter(t => DONE_STATUSES.has(t.status) && !t.contributors.length && !!t.task_date && t.task_date >= period.from && t.task_date <= period.to)
    .sort((a, b) => (a.task_date || '').localeCompare(b.task_date || ''))
}

const inWindow = (date: string | null, day: string, w: { before: number; after: number }) =>
  !!date && date >= addDays(day, -w.before) && date <= addDays(day, w.after)

/**
 * Deliveries in client groups against tasks.
 * - uncredited: the sender is not credited on any of that client's tasks
 *   around the day, while someone else is (when nobody is credited yet, the
 *   task already shows under "no contributors").
 * - noTask: designs went to the client and there is no task around the day.
 */
export function deliveryFindings(tasks: PcTask[], deliveries: PcDelivery[], period: CheckPeriod) {
  const byClient = new Map<string, PcTask[]>()
  for (const t of tasks) {
    if (!t.client_id || t.status === 'cancelled') continue
    const list = byClient.get(t.client_id) || []
    list.push(t)
    byClient.set(t.client_id, list)
  }
  const uncredited: (PcDelivery & { taskIds: string[] })[] = []
  const noTask = new Map<string, { client_id: string; day: string; count: number; senders: string[] }>()
  for (const d of deliveries) {
    if (d.day < period.from || d.day > period.to) continue
    const near = (byClient.get(d.client_id) || []).filter(t => inWindow(t.task_date, d.day, TASK_WINDOW))
    if (!near.length) {
      const key = `${d.client_id}|${d.day}`
      const row = noTask.get(key) || { client_id: d.client_id, day: d.day, count: 0, senders: [] }
      row.count += d.count
      if (!row.senders.includes(d.employee_id)) row.senders.push(d.employee_id)
      noTask.set(key, row)
      continue
    }
    const credited = near.filter(t => t.contributors.length)
    if (!credited.length) continue
    if (credited.some(t => t.contributors.includes(d.employee_id))) continue
    uncredited.push({ ...d, taskIds: credited.map(t => t.id) })
  }
  const byDay = (a: { day: string }, b: { day: string }) => a.day.localeCompare(b.day)
  return { uncredited: uncredited.sort(byDay), noTask: [...noTask.values()].sort(byDay) }
}

/** Posts that went live on a client's page with no task for that client around the day. */
export function postsWithoutTask(tasks: PcTask[], posts: PcPost[], period: CheckPeriod): PcPost[] {
  return posts
    .filter(p => p.day >= period.from && p.day <= period.to)
    .filter(p => !tasks.some(t => t.client_id === p.client_id && t.status !== 'cancelled' && inWindow(t.task_date, p.day, POST_WINDOW)))
    .sort((a, b) => a.day.localeCompare(b.day))
}

/** Count design messages per client, sender and day. */
export function countDeliveries(rows: { client_id: string | null; employee_id: string | null; day: string }[]): PcDelivery[] {
  const map = new Map<string, PcDelivery>()
  for (const r of rows) {
    if (!r.client_id || !r.employee_id) continue
    const key = `${r.client_id}|${r.employee_id}|${r.day}`
    const row = map.get(key) || { client_id: r.client_id, employee_id: r.employee_id, day: r.day, count: 0 }
    row.count++
    map.set(key, row)
  }
  return [...map.values()]
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** The client a group's allow-list name means: exact name first, then a unique partial match. */
export function resolveClientId(name: string, clients: { id: string; name: string }[]): string | null {
  const n = norm(name || '')
  if (!n) return null
  const exact = clients.filter(c => norm(c.name) === n)
  if (exact.length === 1) return exact[0].id
  const partial = clients.filter(c => { const cn = norm(c.name); return cn && (cn.startsWith(n) || n.startsWith(cn)) })
  return partial.length === 1 ? partial[0].id : null
}

export interface PcEmployee { id: string; name: string; salary_day: number | null }
export interface PcPayroll { employee_id: string; status: string; net_salary: number }

/**
 * Pay due soon or late for last month's work: salary day this month (1-31,
 * clamped to the month's length), from three days before. Paid rows and
 * rows owed nothing are left out.
 */
export function payReminders(employees: PcEmployee[], payroll: PcPayroll[], today: string) {
  const last = daysInMonth(today)
  const out: { employee_id: string; name: string; payDate: string; late: boolean; net: number; status: string }[] = []
  for (const e of employees) {
    const day = Math.min(Math.max(1, Math.round(e.salary_day || 1)), last)
    const payDate = `${today.slice(0, 7)}-${String(day).padStart(2, '0')}`
    if (today < addDays(payDate, -3)) continue
    const row = payroll.find(p => p.employee_id === e.id)
    if (!row || row.status === 'paid' || !(row.net_salary > 0)) continue
    out.push({ employee_id: e.id, name: e.name, payDate, late: today > payDate, net: row.net_salary, status: row.status })
  }
  return out.sort((a, b) => a.payDate.localeCompare(b.payDate) || a.name.localeCompare(b.name))
}
