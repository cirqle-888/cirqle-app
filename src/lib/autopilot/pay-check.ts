/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Contribution and pay check: reads everything the rules in
 * pay-check-rules.ts need and returns one report, used by the page
 * (/dashboard/contributions/autocheck) and by the morning autopilot.
 *
 * Read-only. Every source is optional: a missing table (no WhatsApp chat log,
 * no connected Instagram) leaves its section empty with a note, never an error.
 */
import type { Admin } from '@/lib/mcp/shared'
import { fetchAll } from '@/lib/supabase/server'
import { toISODate } from '@/lib/utils/local-date'
import { LISTENER_KEYS, parseGroupList, phoneMatchKey } from '@/lib/whatsapp-listener/rules'
import { unbilledTasks } from '@/lib/mcp/ops-actions'
import { notifyAdmins } from '@/lib/notifications/create'
import { addDays } from './social-rules'
import {
  checkPeriod, countDeliveries, deliveryFindings, DESIGN_TYPES, payReminders, postsWithoutTask, resolveClientId,
  tasksWithoutContributors, TASK_WINDOW, type CheckPeriod, type PcTask,
} from './pay-check-rules'

const CHUNK = 200
async function inChunks<T>(ids: string[], read: (part: string[]) => Promise<{ data: any[] | null; error?: any }>): Promise<{ rows: T[]; error?: string }> {
  const rows: T[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const r = await read(ids.slice(i, i + CHUNK))
    if (r.error) return { rows, error: r.error.message || String(r.error) }
    rows.push(...((r.data || []) as T[]))
  }
  return { rows }
}

const taskLabel = (t: { task_number: number | null; title: string }) => `#${t.task_number ?? '?'} ${t.title}`

export async function buildPayCheck(admin: Admin, today: string, period: CheckPeriod = checkPeriod(today)) {
  const notes: string[] = []
  const wideFrom = addDays(period.from, -TASK_WINDOW.after - 7)
  const wideTo = addDays(period.to, TASK_WINDOW.before + 1)

  // salary_day came with the payroll screens; without it everyone is paid on the 1st.
  const readEmployees = async () => {
    const r = await admin.from('employees').select('id, cqid, phone, salary_day, is_active, is_archived')
    return r.error && /salary_day/.test(r.error.message) ? admin.from('employees').select('id, cqid, phone, is_active, is_archived') : r
  }
  const [clientsRes, empRes, settingsRes, tasksRes] = await Promise.all([
    fetchAll(admin.from('clients').select('id, name')),
    readEmployees(),
    admin.from('company_settings').select('key, value').in('key', [LISTENER_KEYS.groups]),
    fetchAll(admin.from('tasks').select('id, task_number, title, client_id, task_date, status')
      .is('deleted_at', null).gte('task_date', wideFrom).lte('task_date', wideTo)),
  ])
  if (tasksRes.error) return { ok: false as const, error: `tasks: ${tasksRes.error.message ?? tasksRes.error}` }
  if (empRes.error) return { ok: false as const, error: `employees: ${empRes.error.message}` }
  const clients = (clientsRes.data || []) as { id: string; name: string }[]
  const clientName = new Map(clients.map(c => [c.id, c.name]))
  const employees = ((empRes.data || []) as any[])
  // People are labelled by CQID in every message this check sends — never by name.
  const empName = new Map(employees.map(e => [e.id as string, (e.cqid as string) || 'Someone']))
  const byPhone = new Map<string, string>()
  for (const e of employees) { const k = phoneMatchKey(e.phone); if (k && e.is_active && !e.is_archived) byPhone.set(k, e.id) }

  // Tasks with who is credited and who is assigned.
  const rawTasks = (tasksRes.data || []) as any[]
  const ids = rawTasks.map(t => t.id as string)
  const [scores, contribs, assigns] = await Promise.all([
    inChunks<any>(ids, part => admin.from('contribution_scores').select('task_id, employee_id').in('task_id', part) as any),
    inChunks<any>(ids, part => admin.from('contributions').select('task_id, employee_id').in('task_id', part) as any),
    inChunks<any>(ids, part => admin.from('task_assignments').select('task_id, employee_id').in('task_id', part) as any),
  ])
  for (const r of [scores, contribs, assigns]) if (r.error) return { ok: false as const, error: r.error }
  const credit = new Map<string, Set<string>>()
  for (const r of [...scores.rows, ...contribs.rows]) {
    if (!credit.has(r.task_id)) credit.set(r.task_id, new Set())
    credit.get(r.task_id)!.add(r.employee_id)
  }
  const assigned = new Map<string, string[]>()
  for (const r of assigns.rows) assigned.set(r.task_id, [...(assigned.get(r.task_id) || []), r.employee_id])
  const tasks: PcTask[] = rawTasks.map(t => ({
    id: t.id, task_number: t.task_number, title: t.title || 'Untitled', client_id: t.client_id, task_date: t.task_date,
    status: t.status, contributors: [...(credit.get(t.id) || [])], assignees: assigned.get(t.id) || [],
  }))
  const taskById = new Map(tasks.map(t => [t.id, t]))

  // WhatsApp: designs Cirqle people posted in client groups.
  const groups = parseGroupList(((settingsRes.data || []) as any[]).find(r => r.key === LISTENER_KEYS.groups)?.value)
  const chatClient = new Map<string, string | null>()
  const unmatched: string[] = []
  for (const [chatId, name] of groups) {
    if (!name) continue // Cirqle's own groups
    const id = resolveClientId(name, clients)
    chatClient.set(chatId, id)
    if (!id) unmatched.push(name)
  }
  if (unmatched.length) notes.push(`WhatsApp groups not matched to a client (check the names in Settings → WhatsApp): ${unmatched.join(', ')}`)
  let deliveries: ReturnType<typeof countDeliveries> = []
  if (chatClient.size) {
    const msgs = await fetchAll(admin.from('whatsapp_chat_messages').select('chat_id, sender_phone, type, sent_at')
      .in('chat_id', [...chatClient.keys()]).in('type', [...DESIGN_TYPES]).eq('from_cirqle', false)
      .gte('sent_at', `${period.from}T00:00:00+05:30`).lte('sent_at', `${period.to}T23:59:59+05:30`))
    if (msgs.error) notes.push('WhatsApp chat log could not be read, so deliveries were not checked.')
    deliveries = countDeliveries(((msgs.data || []) as any[]).map(m => ({
      client_id: chatClient.get(m.chat_id) ?? null,
      employee_id: byPhone.get(phoneMatchKey(m.sender_phone)) ?? null,
      day: toISODate(new Date(m.sent_at)),
    })))
  } else {
    notes.push('No client WhatsApp groups are on the listener’s list, so deliveries were not checked.')
  }

  // Instagram / Facebook posts on clients' own pages.
  const accRes = await admin.from('social_accounts').select('id, client_id').not('client_id', 'is', null)
  let posts: { client_id: string; day: string; permalink: string | null; kind: string | null }[] = []
  if (!accRes.error && accRes.data?.length) {
    const accClient = new Map(((accRes.data || []) as any[]).map(a => [a.id as string, a.client_id as string]))
    const media = await fetchAll(admin.from('social_media_items').select('account_id, posted_at, permalink, media_product_type, is_story')
      .in('account_id', [...accClient.keys()]).eq('is_story', false)
      .gte('posted_at', `${period.from}T00:00:00+05:30`).lte('posted_at', `${period.to}T23:59:59+05:30`))
    if (media.error) notes.push('Instagram posts could not be read.')
    posts = ((media.data || []) as any[]).filter(m => m.posted_at).map(m => ({
      client_id: accClient.get(m.account_id)!, day: toISODate(new Date(m.posted_at)), permalink: m.permalink ?? null, kind: m.media_product_type ?? null,
    }))
  } else {
    notes.push('No client Instagram or Facebook page is connected, so live posts were not checked.')
  }

  const noContributors = tasksWithoutContributors(tasks, period)
  const { uncredited, noTask } = deliveryFindings(tasks, deliveries, period)
  const postsNoTask = postsWithoutTask(tasks, posts, period)

  // Money: finished work not billed in the period, and pay due for last month's work.
  const unbilled = await unbilledTasks(admin, { from: period.from, to: period.to })
  const prev = new Date(`${today.slice(0, 7)}-01T00:00:00Z`); prev.setUTCMonth(prev.getUTCMonth() - 1)
  const payRes = await admin.from('payroll').select('employee_id, status, net_salary')
    .eq('month', prev.getUTCMonth() + 1).eq('year', prev.getUTCFullYear())
  const pay = payRes.error ? [] : payReminders(
    employees.filter(e => e.is_active && !e.is_archived).map(e => ({ id: e.id, name: e.cqid || 'Someone', salary_day: e.salary_day ?? null })),
    ((payRes.data || []) as any[]).map(p => ({ employee_id: p.employee_id, status: p.status || 'pending', net_salary: Number(p.net_salary ?? 0) })),
    today,
  )

  const report = {
    period,
    noContributors: noContributors.map(t => ({
      id: t.id, label: taskLabel(t), client: clientName.get(t.client_id || '') || '', date: t.task_date,
      assignees: t.assignees.map(id => empName.get(id) || 'Someone'),
    })),
    uncredited: uncredited.map(u => ({
      client: clientName.get(u.client_id) || '', person: empName.get(u.employee_id) || 'Someone', day: u.day, count: u.count,
      tasks: u.taskIds.map(id => { const t = taskById.get(id)!; return { id, label: taskLabel(t), credited: t.contributors.map(c => empName.get(c) || 'Someone') } }),
    })),
    deliveriesWithoutTask: noTask.map(n => ({
      client: clientName.get(n.client_id) || '', clientId: n.client_id, day: n.day, count: n.count, people: n.senders.map(id => empName.get(id) || 'Someone'),
    })),
    postsWithoutTask: postsNoTask.map(p => ({ client: clientName.get(p.client_id) || '', clientId: p.client_id, day: p.day, permalink: p.permalink, kind: p.kind })),
    unbilled: unbilled.ok ? { count: unbilled.unbilled.length, total_inr: unbilled.total_inr, items: unbilled.unbilled.slice(0, 30) } : { count: 0, total_inr: 0, items: [] },
    pay,
    notes,
  }
  return { ok: true as const, report }
}

export type PayCheckReport = Extract<Awaited<ReturnType<typeof buildPayCheck>>, { ok: true }>['report']

export function payCheckCounts(r: PayCheckReport) {
  return {
    noContributors: r.noContributors.length,
    uncredited: r.uncredited.length,
    deliveriesWithoutTask: r.deliveriesWithoutTask.length,
    postsWithoutTask: r.postsWithoutTask.length,
    unbilled: r.unbilled.count,
    pay: r.pay.length,
  }
}

/**
 * The morning job: pay reminders every day they apply; the full summary on
 * Mondays and in the first week of the month (when last month is paid).
 */
export async function payCheckJob(admin: Admin, today: string) {
  const built = await buildPayCheck(admin, today)
  if (!built.ok) return built
  const r = built.report
  const counts = payCheckCounts(r)
  const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
  if (r.pay.length) {
    const late = r.pay.filter(p => p.late)
    await notifyAdmins({
      type: 'autopilot_pay_due',
      title: late.length
        ? `Salary late for ${late.length} ${late.length === 1 ? 'person' : 'people'}`
        : `Salary due soon for ${r.pay.length} ${r.pay.length === 1 ? 'person' : 'people'}`,
      message: r.pay.slice(0, 6).map(p => `${p.name} ${inr(p.net)} on ${p.payDate}${p.late ? ' (late)' : ''}`).join(' · ') +
        '. Check the contribution list first, then mark payroll paid.',
      link: '/dashboard/contributions/autocheck',
      sourceKey: `autopilot_pay_due:${today}`,
    })
  }
  const day = Number(today.slice(8, 10))
  const monday = new Date(`${today}T00:00:00Z`).getUTCDay() === 1
  const issues = counts.noContributors + counts.uncredited + counts.deliveriesWithoutTask + counts.postsWithoutTask
  if ((monday || day <= 7) && (issues || counts.unbilled)) {
    const parts = [
      counts.noContributors && `${counts.noContributors} finished task${counts.noContributors === 1 ? '' : 's'} with nobody credited`,
      counts.uncredited && `${counts.uncredited} delivery${counts.uncredited === 1 ? '' : 'ies'} by someone not credited`,
      counts.deliveriesWithoutTask && `${counts.deliveriesWithoutTask} day${counts.deliveriesWithoutTask === 1 ? '' : 's'} of designs sent with no task`,
      counts.postsWithoutTask && `${counts.postsWithoutTask} live post${counts.postsWithoutTask === 1 ? '' : 's'} with no task`,
      counts.unbilled && `${counts.unbilled} finished job${counts.unbilled === 1 ? '' : 's'} not billed (${inr(r.unbilled.total_inr)})`,
    ].filter(Boolean)
    await notifyAdmins({
      type: 'autopilot_pay_check',
      title: `Contribution and pay check: ${issues} thing${issues === 1 ? '' : 's'} to look at`,
      message: parts.join(' · '),
      link: '/dashboard/contributions/autocheck',
      sourceKey: `autopilot_pay_check:${today}`,
    })
  }
  return { ok: true as const, period: r.period, ...counts }
}
