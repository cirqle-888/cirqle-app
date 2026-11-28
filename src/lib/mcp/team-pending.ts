/* eslint-disable @typescript-eslint/no-explicit-any -- rows from the untyped Supabase admin client; each is narrowed before it leaves this file. */
/**
 * Pending work for each person (by CQID), as a short point-wise list that can
 * be shared as it is, and a morning reminder that sends each list to its
 * person as a Cirqle chat DM from the owner.
 *
 * What counts as PENDING for a person:
 *   · an open request assigned to them (the inbox's open statuses), unless it
 *     already became a task: then the task is the work and is listed instead;
 *   · a task that is pending or in progress with them among its assignees.
 * Requests waiting for the client's content are listed apart: they are not
 * the person's move, but they should know to follow up.
 *
 * People are shown by CQID only, never by name (see check-name-privacy).
 * Pure parts (buildTeamPending, formatPendingMessage) need no database.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAll } from '@/lib/supabase/server'
import { sendWebPush } from '@/lib/push/send'
import { OPEN_REQUEST_STATUSES } from './ops-actions'

type Admin = SupabaseClient<any, any, any>

export const OPEN_TASK_STATUSES = ['pending', 'in_progress'] as const
const WAITING_ON_CLIENT = 'waiting_for_content'
/** Days ahead counted as "coming up". */
export const COMING_UP_DAYS = 3
/** Lines per section in a message; the rest are counted. */
const MAX_PER_SECTION = 12

export type Bucket = 'late' | 'today' | 'soon' | 'later' | 'no_date' | 'waiting_client'

export interface PendingItem {
  kind: 'request' | 'task'
  ref: string            // REQ-0141 or #2076
  title: string
  client: string | null
  due: string | null     // YYYY-MM-DD
  status: string
  bucket: Bucket
}

export interface PersonPending {
  employeeId: string
  cqid: string
  items: PendingItem[]
  counts: Record<Bucket, number>
}

export interface TeamPendingInput {
  today: string
  employees: readonly { id: string; cqid: string; archived?: boolean }[]
  requests: readonly {
    ref_no: number; title: string | null; status: string; due_date: string | null
    assigned_employee_id: string | null; promoted_task_id: string | null; client: string | null
  }[]
  tasks: readonly {
    id: string; task_number: number; title: string | null; status: string; task_date: string | null
    client: string | null; assignees: readonly string[]
  }[]
}

export interface TeamPending {
  today: string
  people: PersonPending[]
  /** Open requests with nobody assigned: someone has to pick them up. */
  unassigned: PendingItem[]
}

const refOf = (n: number) => `REQ-${String(n).padStart(4, '0')}`
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10)
}

export function bucketOf(due: string | null, status: string, today: string): Bucket {
  if (status === WAITING_ON_CLIENT) return 'waiting_client'
  if (!due) return 'no_date'
  if (due < today) return 'late'
  if (due === today) return 'today'
  if (due <= addDays(today, COMING_UP_DAYS)) return 'soon'
  return 'later'
}

const ORDER: Bucket[] = ['late', 'today', 'soon', 'later', 'no_date', 'waiting_client']
const emptyCounts = (): Record<Bucket, number> => ({ late: 0, today: 0, soon: 0, later: 0, no_date: 0, waiting_client: 0 })

export function buildTeamPending(input: TeamPendingInput): TeamPending {
  const { today } = input
  const byPerson = new Map<string, PendingItem[]>()
  const push = (id: string, item: PendingItem) => {
    const list = byPerson.get(id) ?? []
    list.push(item); byPerson.set(id, list)
  }
  const unassigned: PendingItem[] = []
  const openTaskIds = new Set(input.tasks.map(t => t.id))

  for (const r of input.requests) {
    if (!OPEN_REQUEST_STATUSES.includes(r.status)) continue
    // Became a task: the open task carries it; a finished task means nothing is left.
    if (r.promoted_task_id) continue
    const item: PendingItem = {
      kind: 'request', ref: refOf(r.ref_no), title: (r.title || '').trim() || 'Untitled',
      client: r.client, due: r.due_date, status: r.status, bucket: bucketOf(r.due_date, r.status, today),
    }
    if (r.assigned_employee_id) push(r.assigned_employee_id, item)
    else unassigned.push(item)
  }
  for (const t of input.tasks) {
    if (!(OPEN_TASK_STATUSES as readonly string[]).includes(t.status) || !openTaskIds.has(t.id)) continue
    const item: PendingItem = {
      kind: 'task', ref: `#${t.task_number}`, title: (t.title || '').trim() || 'Untitled',
      client: t.client, due: t.task_date, status: t.status, bucket: bucketOf(t.task_date, t.status, today),
    }
    for (const id of new Set(t.assignees)) push(id, item)
  }

  const sortItems = (a: PendingItem, b: PendingItem) =>
    ORDER.indexOf(a.bucket) - ORDER.indexOf(b.bucket) || (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.ref.localeCompare(b.ref)

  const people: PersonPending[] = []
  for (const e of input.employees) {
    if (e.archived) continue
    const items = (byPerson.get(e.id) ?? []).sort(sortItems)
    if (!items.length) continue
    const counts = emptyCounts()
    for (const i of items) counts[i.bucket]++
    people.push({ employeeId: e.id, cqid: e.cqid, items, counts })
  }
  // Most late work first, then most work.
  people.sort((a, b) => b.counts.late - a.counts.late || b.items.length - a.items.length || a.cqid.localeCompare(b.cqid))
  return { today, people, unassigned: unassigned.sort(sortItems) }
}

// ── Message text ─────────────────────────────────────────────────────────────

const HEADINGS: Record<Bucket, string> = {
  late: 'വൈകിയത് / Late',
  today: 'ഇന്ന് / Today',
  soon: 'അടുത്ത ദിവസങ്ങളിൽ / Next few days',
  later: 'പിന്നീട് / Later',
  no_date: 'തീയതി ഇല്ല / No date',
  waiting_client: 'Client-ന്റെ മറുപടി കാത്ത് / Waiting for client',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const shortDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`

function line(n: number, i: PendingItem): string {
  const parts = [`${i.ref} ${i.title}`]
  if (i.client) parts.push(i.client)
  if (i.due && i.bucket !== 'today') parts.push(shortDate(i.due))
  return `${n}. ${parts.join(' · ')}`
}

/** One person's list, Malayalam first then a short English summary; ready to share as it is. */
export function formatPendingMessage(p: PersonPending, today: string, baseUrl = 'https://app.cirqle.work'): string {
  const out: string[] = [`${p.cqid} · ഇന്നത്തെ pending (${shortDate(today)})`]
  let n = 0
  for (const b of ORDER) {
    const list = p.items.filter(i => i.bucket === b)
    if (!list.length) continue
    out.push('', `${HEADINGS[b]} (${list.length}):`)
    for (const i of list.slice(0, MAX_PER_SECTION)) out.push(line(++n, i))
    if (list.length > MAX_PER_SECTION) out.push(`+ ${list.length - MAX_PER_SECTION} more`)
  }

  const c = p.counts
  const ml: string[] = []
  if (c.late) ml.push(`വൈകിയ ${c.late} എണ്ണം ആദ്യം തീർക്കുക.`)
  if (c.today) ml.push(`ഇന്ന് ${c.today} എണ്ണം കൊടുക്കണം.`)
  if (c.waiting_client) ml.push(`${c.waiting_client} എണ്ണത്തിന് client-നോട് content ചോദിക്കുക.`)
  ml.push('കഴിഞ്ഞാൽ Cirqle-ൽ status മാറ്റുക.')

  const en: string[] = []
  const bits = [
    c.late && `${c.late} late`, c.today && `${c.today} due today`, c.soon && `${c.soon} in the next few days`,
    c.later && `${c.later} later`, c.no_date && `${c.no_date} with no date`, c.waiting_client && `${c.waiting_client} waiting for the client`,
  ].filter(Boolean)
  en.push(`You have ${bits.join(', ')}.`)
  if (c.late) en.push('Please finish the late ones first.')
  en.push('Update the status in Cirqle when done.')

  out.push('', ml.join(' '), en.join(' '), `${baseUrl.replace(/\/$/, '')}/dashboard/my-work`)
  return out.join('\n')
}

/** The whole team in one shareable block (for the owner's brief or a group). */
export function formatTeamSummary(t: TeamPending): string {
  if (!t.people.length && !t.unassigned.length) return `${shortDate(t.today)}: ആർക്കും pending ഇല്ല / Nobody has pending work.`
  const out: string[] = [`Team pending · ${shortDate(t.today)}`]
  for (const p of t.people) {
    const c = p.counts
    const head = [`${p.items.length} pending`, c.late && `${c.late} late`, c.today && `${c.today} today`].filter(Boolean).join(', ')
    out.push('', `${p.cqid}: ${head}`)
    for (const i of p.items.filter(x => x.bucket === 'late' || x.bucket === 'today').slice(0, 6)) out.push(`• ${i.ref} ${i.title}${i.client ? ` · ${i.client}` : ''}`)
  }
  if (t.unassigned.length) {
    out.push('', `ആരെയും ഏൽപ്പിക്കാത്തത് / Not assigned (${t.unassigned.length}):`)
    for (const i of t.unassigned.slice(0, 8)) out.push(`• ${i.ref} ${i.title}${i.client ? ` · ${i.client}` : ''}`)
    if (t.unassigned.length > 8) out.push(`+ ${t.unassigned.length - 8} more`)
  }
  return out.join('\n')
}

// ── Loading ──────────────────────────────────────────────────────────────────

export async function loadTeamPending(admin: Admin, today: string): Promise<TeamPending> {
  const [employees, requests, tasks] = await Promise.all([
    fetchAll(admin.from('employees').select('id, cqid, is_archived')),
    fetchAll(admin.from('task_requests')
      .select('ref_no, title, status, due_date, assigned_employee_id, promoted_task_id, client:clients(name)')
      .in('status', OPEN_REQUEST_STATUSES).is('archived_at', null)),
    fetchAll(admin.from('tasks')
      .select('id, task_number, title, status, task_date, client:clients(name), assignments:task_assignments(employee_id)')
      .in('status', [...OPEN_TASK_STATUSES]).is('deleted_at', null)),
  ])
  const failed = [employees, requests, tasks].find(r => r.error)
  if (failed) throw new Error(`Could not load pending work: ${failed.error?.message ?? 'unknown error'}`)
  const one = (v: any) => (Array.isArray(v) ? v[0] : v)
  return buildTeamPending({
    today,
    employees: (employees.data as any[]).map(e => ({ id: e.id, cqid: e.cqid, archived: !!e.is_archived })),
    requests: (requests.data as any[]).map(r => ({ ...r, client: one(r.client)?.name ?? null })),
    tasks: (tasks.data as any[]).map(t => ({
      id: t.id, task_number: t.task_number, title: t.title, status: t.status, task_date: t.task_date,
      client: one(t.client)?.name ?? null, assignees: ((t.assignments ?? []) as any[]).map(a => a.employee_id),
    })),
  })
}

// ── Sending as chat DMs ──────────────────────────────────────────────────────

/** The owner's employee row by CQID; only a super admin may send these. */
export async function resolveSender(admin: Admin, cqid: string) {
  const { data, error } = await admin.from('employees').select('id, cqid, role, is_archived')
    .ilike('cqid', cqid.trim()).maybeSingle()
  if (error) return { ok: false as const, error: error.message }
  const e = data as any
  if (!e || e.is_archived) return { ok: false as const, error: `No active employee with CQID ${cqid}.` }
  if (e.role !== 'super_admin') return { ok: false as const, error: `${e.cqid} is not an admin, so reminders cannot be sent from this account.` }
  return { ok: true as const, id: e.id as string, cqid: e.cqid as string }
}

/** The live 1:1 DM between two people, created when there is none. */
export async function findOrCreateDm(admin: Admin, a: string, b: string): Promise<string> {
  const { data: mine, error } = await admin.from('conversation_members')
    .select('conversation_id, conversation:conversation_id(type, archived_at)').eq('employee_id', a)
  if (error) throw new Error(error.message)
  const dmIds = ((mine ?? []) as any[])
    .filter(r => { const c = Array.isArray(r.conversation) ? r.conversation[0] : r.conversation; return c?.type === 'dm' && !c?.archived_at })
    .map(r => r.conversation_id as string)
  if (dmIds.length) {
    const { data: shared } = await admin.from('conversation_members')
      .select('conversation_id').in('conversation_id', dmIds).eq('employee_id', b)
    const hit = ((shared ?? []) as any[])[0]
    if (hit) return hit.conversation_id as string
  }
  const { data: conv, error: cErr } = await admin.from('conversations')
    .insert({ type: 'dm', is_private: true, created_by: a }).select('id').single()
  if (cErr || !conv) throw new Error(cErr?.message ?? 'Could not open the chat.')
  const { error: mErr } = await admin.from('conversation_members').insert([
    { conversation_id: (conv as any).id, employee_id: a, role: 'member' },
    { conversation_id: (conv as any).id, employee_id: b, role: 'member' },
  ])
  if (mErr) throw new Error(mErr.message)
  return (conv as any).id as string
}

export interface ReminderResult {
  sent: { cqid: string; items: number; late: number }[]
  skipped: { cqid: string; reason: string }[]
}

/**
 * Send each person their own list as a DM from `fromCqid`. Safe to run again
 * the same day: a person who already got today's reminder is skipped.
 */
export async function sendPendingReminders(
  admin: Admin, opts: { fromCqid: string; today: string; cqids?: string[]; baseUrl?: string },
): Promise<{ ok: true; result: ReminderResult } | { ok: false; error: string }> {
  const sender = await resolveSender(admin, opts.fromCqid)
  if (!sender.ok) return sender
  const team = await loadTeamPending(admin, opts.today)
  const wanted = opts.cqids?.length ? new Set(opts.cqids.map(c => c.trim().toUpperCase())) : null
  const res: ReminderResult = { sent: [], skipped: [] }
  if (wanted) {
    for (const c of wanted) if (!team.people.some(p => p.cqid.toUpperCase() === c)) res.skipped.push({ cqid: c, reason: 'nothing pending' })
  }

  for (const p of team.people) {
    if (wanted && !wanted.has(p.cqid.toUpperCase())) continue
    if (p.employeeId === sender.id) { res.skipped.push({ cqid: p.cqid, reason: 'the sender' }); continue }
    try {
      const conversationId = await findOrCreateDm(admin, sender.id, p.employeeId)
      const { data: already } = await admin.from('messages').select('id')
        .eq('conversation_id', conversationId).eq('sender_id', sender.id)
        .contains('metadata', { pending_reminder: opts.today }).limit(1)
      if (already?.length) { res.skipped.push({ cqid: p.cqid, reason: 'already sent today' }); continue }
      const body = formatPendingMessage(p, opts.today, opts.baseUrl)
      const { error } = await admin.from('messages').insert({
        conversation_id: conversationId, sender_id: sender.id, body, kind: 'text',
        metadata: { pending_reminder: opts.today },
      })
      if (error) { res.skipped.push({ cqid: p.cqid, reason: error.message }); continue }
      // Bring the DM back if either side had hidden it, so the reminder is seen.
      await admin.from('conversation_members').update({ hidden_at: null }).eq('conversation_id', conversationId)
      await sendWebPush(p.employeeId, {
        title: `💬 ${sender.cqid}`,
        body: `${p.items.length} pending${p.counts.late ? `, ${p.counts.late} late` : ''}`,
        url: `/dashboard/chat?c=${conversationId}`,
        tag: `msg:${conversationId}`,
      }).catch(() => undefined)
      res.sent.push({ cqid: p.cqid, items: p.items.length, late: p.counts.late })
    } catch (e) {
      res.skipped.push({ cqid: p.cqid, reason: e instanceof Error ? e.message : 'could not send' })
    }
  }
  return { ok: true, result: res }
}
