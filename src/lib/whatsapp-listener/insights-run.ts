/**
 * WhatsApp insights — the part that talks to the database and the AI.
 * The rules are in insights.ts.
 *
 *   updateChatReport   one chat: read the new messages, ask the AI for the
 *                      day's summary and the open items, store them, and tell
 *                      the right person inside Cirqle about anything new that
 *                      is waiting on Cirqle.
 *   updateAllReports   every allow-listed chat with new messages.
 *   loadChatViewer     who is looking, and which chats they may see.
 *
 * Alerts are Cirqle notifications (bell + push). Nothing is sent to WhatsApp.
 */

import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { callGroqJSON, callGroqText } from '@/lib/ai/groq'
import { createNotification, notifyAdmins } from '@/lib/notifications/create'
import { loadCurrentUser, type CurrentUser } from '@/lib/permissions/check'
import { CHAT_LOG_TABLE, chatDisplayName, indiaDay, isMissingTable } from './chat-log'
import {
  ACCESS_KEY, ASK_PROMPT, REPORT_PROMPT, REPORT_TABLE, alertTargets, chatAlertTargets, chatsInQuestion, daysBetween, normalizeReport, parseAccess,
  parseItems, reportInput, transcript, visibleChatIds, type ChatAccess, type InsightMessage, type PendingItem, type Viewer,
  WAITING_MAX_HOURS,
  latestReports,
  waitingChats,
  weeklyDigest,
  type LastMessage,
  type ReportRow,
} from './insights'
import { LISTENER_KEYS, parseGroupList, parseGroupNames } from './rules'

const PENDING_LINK = '/dashboard/requests/whatsapp/pending'
/** Most messages read for one report: a busy group's day, with room to spare. */
const MAX_MESSAGES = 250

export interface ListenerContext {
  settings: Record<string, string>
  /** Allow-listed chats: chat id → client name. */
  groups: Map<string, string>
  names: Record<string, string>
  access: Record<string, ChatAccess>
}

export async function loadListenerContext(admin: SupabaseClient): Promise<ListenerContext> {
  const { data } = await admin.from('company_settings').select('key, value').like('key', 'whatsapp_listener_%')
  const settings = Object.fromEntries(((data || []) as { key: string; value: string | null }[]).map(r => [r.key, r.value ?? '']))
  return {
    settings,
    groups: parseGroupList(settings[LISTENER_KEYS.groups]),
    names: parseGroupNames(settings[LISTENER_KEYS.groupNames]),
    access: parseAccess(settings[ACCESS_KEY]),
  }
}

export const chatTitle = (ctx: Pick<ListenerContext, 'groups' | 'names'>, chatId: string): string =>
  chatDisplayName(ctx.names[chatId], ctx.groups.get(chatId), chatId)

export interface ChatViewer {
  me: CurrentUser | null
  viewer: Viewer | null
  ctx: ListenerContext
  /** The allow-listed chats this person may read. Empty when signed out. */
  visible: Set<string>
}

/** Who is looking and what they may see. The one gate every WhatsApp page and action goes through. */
export async function loadChatViewer(admin: SupabaseClient): Promise<ChatViewer> {
  const [me, ctx] = await Promise.all([loadCurrentUser().catch(() => null), loadListenerContext(admin)])
  // Admins see every chat, so their departments are never needed.
  const mine = me && !me.isAdmin
    ? await admin.from('employee_service_categories').select('category_id').eq('employee_id', me.employeeId)
    : { data: [] }
  const viewer: Viewer | null = me
    ? {
        isAdmin: me.isAdmin, employeeId: me.employeeId, canViewRequests: me.isAdmin || me.permissions.has('requests.view'),
        departmentIds: ((mine.data || []) as { category_id: string }[]).map(r => r.category_id),
      }
    : null
  return { me, viewer, ctx, visible: visibleChatIds(viewer, ctx.groups.keys(), ctx.access) }
}

export type ReportOutcome =
  | { result: 'updated'; items: number; alerts: number }
  | { result: 'skipped'; reason: 'no-new-messages' | 'no-table' | 'not-listed' }
  | { result: 'failed'; error: string }

interface StoredReport { report_day: string; summary: string; items: unknown; message_count: number; covered_until: string | null }

/** Department id → the active employees in it. */
export async function departmentMembers(admin: SupabaseClient): Promise<Map<string, string[]>> {
  const [links, staff] = await Promise.all([
    admin.from('employee_service_categories').select('employee_id, category_id'),
    admin.from('employees').select('id').eq('is_active', true).eq('is_archived', false),
  ])
  const active = new Set(((staff.data || []) as { id: string }[]).map(e => e.id))
  const out = new Map<string, string[]>()
  for (const l of (links.data || []) as { employee_id: string; category_id: string }[]) {
    if (active.has(l.employee_id)) (out.get(l.category_id) ?? out.set(l.category_id, []).get(l.category_id)!).push(l.employee_id)
  }
  return out
}

async function activeEmployees(admin: SupabaseClient): Promise<{ id: string; name: string }[]> {
  const { data } = await admin.from('employees').select('id, name').eq('is_active', true).eq('is_archived', false)
  return ((data || []) as { id: string; name: string | null }[]).filter(e => e.name).map(e => ({ id: e.id, name: e.name as string }))
}

async function alertNewItems(
  o: { chatId: string; title: string; items: PendingItem[]; newIds: string[]; access: ChatAccess | undefined; employees: { id: string; name: string }[]; members: Map<string, string[]> },
): Promise<number> {
  let sent = 0
  for (const item of o.items) {
    if (!o.newIds.includes(item.id) || item.waitingOn !== 'cirqle') continue
    const content = {
      type: 'whatsapp_pending',
      title: `Action needed — ${o.title}`,
      message: item.text,
      link: PENDING_LINK,
      // Once per item, however many times the report is rebuilt.
      sourceKey: `whatsapp_pending:${item.id}`,
    }
    const targets = alertTargets(item, o.access, o.employees, o.members)
    if (targets.length) for (const employeeId of targets) await createNotification({ ...content, employeeId })
    else await notifyAdmins(content)
    sent++
  }
  return sent
}

export async function updateChatReport(
  admin: SupabaseClient,
  ctx: ListenerContext,
  chatId: string,
  employees?: { id: string; name: string }[],
  members?: Map<string, string[]>,
): Promise<ReportOutcome> {
  if (!ctx.groups.has(chatId)) return { result: 'skipped', reason: 'not-listed' }

  const last = await admin.from(REPORT_TABLE)
    .select('report_day, summary, items, message_count, covered_until')
    .eq('chat_id', chatId).order('report_day', { ascending: false }).limit(1).maybeSingle()
  if (last.error) return isMissingTable(last.error) ? { result: 'skipped', reason: 'no-table' } : { result: 'failed', error: last.error.message }
  const prev = last.data as StoredReport | null

  let q = admin.from(CHAT_LOG_TABLE).select('*').eq('chat_id', chatId).order('sent_at', { ascending: false }).limit(MAX_MESSAGES)
  if (prev?.covered_until) q = q.gt('sent_at', prev.covered_until)
  const msgs = await q
  if (msgs.error) return isMissingTable(msgs.error) ? { result: 'skipped', reason: 'no-table' } : { result: 'failed', error: msgs.error.message }
  const messages = ((msgs.data || []) as InsightMessage[]).reverse()
  if (messages.length === 0) return { result: 'skipped', reason: 'no-new-messages' }

  const today = indiaDay(new Date().toISOString())
  const title = chatTitle(ctx, chatId)
  const openBefore = parseItems(prev?.items)
  let ai: unknown
  try {
    ai = await callGroqJSON(
      REPORT_PROMPT,
      reportInput({ chatTitle: title, client: ctx.groups.get(chatId) || '', openItems: openBefore, transcript: transcript(messages) }),
      { maxTokens: 1400 },
    )
  } catch (err) {
    return { result: 'failed', error: err instanceof Error ? err.message : 'AI call failed' }
  }
  // An empty answer means the AI call went wrong, not that the chat is clear:
  // storing it would wipe the open list.
  if (!ai || typeof ai !== 'object' || !('items' in ai)) return { result: 'failed', error: 'The AI gave no usable answer.' }

  const report = normalizeReport(ai, openBefore, { today, newId: () => randomUUID().slice(0, 8) })
  const sameDay = prev?.report_day === today
  const { error } = await admin.from(REPORT_TABLE).upsert({
    chat_id: chatId,
    report_day: today,
    // A second run on the same day adds to that day's story instead of replacing it.
    summary: sameDay && prev?.summary ? `${prev.summary} ${report.summary}`.trim().slice(0, 2400) : report.summary,
    items: report.items,
    message_count: (sameDay ? prev?.message_count ?? 0 : 0) + messages.length,
    covered_until: messages[messages.length - 1].sent_at,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'chat_id,report_day' })
  if (error) return { result: 'failed', error: error.message }

  const alerts = await alertNewItems({
    chatId, title, items: report.items, newIds: report.newIds, access: ctx.access[chatId],
    employees: employees ?? await activeEmployees(admin),
    members: members ?? await departmentMembers(admin),
  }).catch(() => 0)
  return { result: 'updated', items: report.items.length, alerts }
}

export interface RunSummary { chats: number; updated: number; skipped: number; failed: number; alerts: number; outOfTime: boolean; errors: string[] }

/**
 * Every allow-listed chat, one after another (the free AI tier allows only a
 * few calls a minute). Stops when the time budget runs out; the chats it did
 * not reach are picked up by the next run, since each remembers where it got to.
 */
export async function updateAllReports(admin: SupabaseClient, o: { budgetMs: number; chatIds?: Iterable<string> }): Promise<RunSummary> {
  const started = Date.now()
  const ctx = await loadListenerContext(admin)
  const employees = await activeEmployees(admin)
  const members = await departmentMembers(admin)
  const out: RunSummary = { chats: 0, updated: 0, skipped: 0, failed: 0, alerts: 0, outOfTime: false, errors: [] }
  for (const chatId of o.chatIds ?? ctx.groups.keys()) {
    if (Date.now() - started > o.budgetMs) { out.outOfTime = true; break }
    out.chats++
    const r = await updateChatReport(admin, ctx, chatId, employees, members)
    if (r.result === 'updated') { out.updated++; out.alerts += r.alerts }
    else if (r.result === 'skipped') { out.skipped++; if (r.reason === 'no-table') break }
    else { out.failed++; if (out.errors.length < 3) out.errors.push(r.error.slice(0, 160)) }
  }
  return out
}

// ── End-of-day nudges (the evening run only) ────────────────────────────────

/** Tells the responsible person about each client who spoke last and has had no reply. */
export async function alertUnanswered(admin: SupabaseClient, ctx: ListenerContext): Promise<number> {
  const ids = [...ctx.groups.keys()]
  if (!ids.length) return 0
  const since = new Date(Date.now() - WAITING_MAX_HOURS * 3_600_000).toISOString()
  const { data, error } = await admin.from(CHAT_LOG_TABLE)
    .select('chat_id, message_id, from_cirqle, type, body, sent_at')
    .in('chat_id', ids).gte('sent_at', since).order('sent_at', { ascending: false }).limit(3000)
  if (error || !data) return 0
  const members = await departmentMembers(admin)
  let sent = 0
  for (const w of waitingChats(data as LastMessage[], Date.now())) {
    const content = {
      type: 'whatsapp_pending' as const,
      title: `Waiting for a reply — ${chatTitle(ctx, w.chatId)}`,
      message: `The client wrote ${w.hours} hour${w.hours === 1 ? '' : 's'} ago and nobody from Cirqle has answered in the group.`,
      link: `/dashboard/requests/whatsapp?chat=${encodeURIComponent(w.chatId)}`,
      // Once per unanswered message, however many evenings it stays unanswered.
      sourceKey: `whatsapp_waiting:${w.messageId}`,
    }
    const targets = chatAlertTargets(ctx.access[w.chatId], members)
    if (targets.length) for (const employeeId of targets) await createNotification({ ...content, employeeId })
    else await notifyAdmins(content)
    sent++
  }
  return sent
}

/** Monday's one-line summary of the week for the admins. */
export async function sendWeeklyDigest(admin: SupabaseClient, ctx: ListenerContext): Promise<boolean> {
  const today = indiaDay(new Date().toISOString())
  if (new Date(`${today}T00:00:00Z`).getUTCDay() !== 1) return false
  const ids = [...ctx.groups.keys()]
  if (!ids.length) return false
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 45 * 86_400_000).toISOString().slice(0, 10)
  const weekFrom = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10)
  const { data, error } = await admin.from(REPORT_TABLE)
    .select('chat_id, report_day, summary, items, message_count, covered_until, updated_at')
    .in('chat_id', ids).gte('report_day', from).limit(3000)
  if (error || !data) return false
  const rows = data as ReportRow[]
  const message = weeklyDigest(rows.filter(r => r.report_day >= weekFrom), latestReports(rows), today, id => chatTitle(ctx, id))
  if (!message) return false
  await notifyAdmins({
    type: 'whatsapp_pending', title: 'WhatsApp chats — the week', message,
    link: PENDING_LINK, sourceKey: `whatsapp_weekly:${today}`,
  })
  return true
}

// ── Asking a question ───────────────────────────────────────────────────────

/** Notes handed to the AI for one question: bounded, and only from chats the asker may see. */
const ASK_MAX_CHARS = 14_000

export async function answerQuestion(
  admin: SupabaseClient, cv: ChatViewer, question: string,
): Promise<{ ok: true; answer: string; chats: string[] } | { ok: false; error: string }> {
  const q = question.replace(/\s+/g, ' ').trim().slice(0, 500)
  if (q.length < 3) return { ok: false, error: 'Type a question first.' }
  if (cv.visible.size === 0) return { ok: false, error: 'No WhatsApp chats are shared with you.' }

  const chats = [...cv.visible].map(chatId => ({ chatId, title: chatTitle(cv.ctx, chatId), client: cv.ctx.groups.get(chatId) || '' }))
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
  const reports = await admin.from(REPORT_TABLE)
    .select('chat_id, report_day, summary, items')
    .in('chat_id', chats.map(c => c.chatId)).gte('report_day', since).order('report_day', { ascending: false })
  if (reports.error && isMissingTable(reports.error)) return { ok: false, error: 'Reports are not switched on yet (the database change has not been applied).' }
  const rows = (reports.data || []) as { chat_id: string; report_day: string; summary: string; items: unknown }[]

  const today = indiaDay(new Date().toISOString())
  const named = chatsInQuestion(q, chats)
  const sections: string[] = []
  // The chats the question names come first and in full; the rest only as their open items.
  const order = [...chats].sort((a, b) => Number(named.includes(b.chatId)) - Number(named.includes(a.chatId)))
  for (const c of order) {
    const mine = rows.filter(r => r.chat_id === c.chatId)
    const isNamed = named.includes(c.chatId)
    const open = parseItems(mine[0]?.items)
    if (!isNamed && open.length === 0) continue
    const lines = [`## ${c.title}${c.client ? ` (client: ${c.client})` : ' (internal)'}`]
    lines.push(open.length
      ? `Open items:\n${open.map(i => `- waiting on ${i.waitingOn === 'cirqle' ? 'Cirqle' : 'the client'}${i.who ? ` (${i.who})` : ''}, ${i.since ? `${daysBetween(i.since, today)} day(s)` : 'recently'}: ${i.text}`).join('\n')}`
      : 'Open items: none')
    if (isNamed) {
      for (const r of mine.slice(0, 5)) if (r.summary) lines.push(`${r.report_day}: ${r.summary}`)
      const [msgs, reqs] = await Promise.all([
        admin.from(CHAT_LOG_TABLE).select('*').eq('chat_id', c.chatId).order('sent_at', { ascending: false }).limit(40),
        c.client
          ? admin.from('task_requests').select('ref_no, title, status, created_at, client:clients!inner(name)')
            .eq('client.name', c.client).is('archived_at', null)
            .not('status', 'in', '("completed","cancelled","rejected","archived","delivered")').order('created_at', { ascending: false }).limit(15)
          : Promise.resolve({ data: [] as unknown[] }),
      ])
      const recent = ((msgs.data || []) as InsightMessage[]).reverse()
      if (recent.length) lines.push(`Latest messages:\n${transcript(recent, 4000)}`)
      const open2 = (reqs.data || []) as { ref_no: number | null; title: string; status: string; created_at: string }[]
      if (open2.length) lines.push(`Open requests in Cirqle:\n${open2.map(r => `- REQ-${String(r.ref_no ?? 0).padStart(4, '0')} ${r.title} (${r.status.replace(/_/g, ' ')}, since ${r.created_at.slice(0, 10)})`).join('\n')}`)
    }
    sections.push(lines.join('\n'))
  }
  if (sections.length === 0) return { ok: true, answer: 'Nothing is open in the chats you can see, and the question does not name a client I have a chat for.', chats: [] }

  let notes = ''
  for (const s of sections) { if (notes.length + s.length > ASK_MAX_CHARS) break; notes += `${s}\n\n` }
  try {
    const answer = await callGroqText(ASK_PROMPT, `Today is ${today}.\n\nNotes:\n${notes}\nQuestion: ${q}`, { maxTokens: 700 })
    return answer ? { ok: true, answer, chats: named.map(id => chatTitle(cv.ctx, id)) } : { ok: false, error: 'The AI gave no answer. Try again.' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'The AI could not be reached.' }
  }
}
