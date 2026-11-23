/**
 * WhatsApp requests kept in step with the chat — the database side.
 * Rules and the reasons: request-sync.ts.
 *
 * Runs for one chat whenever Cirqle writes in it (the webhook), and for every
 * chat in the evening job, which also catches a request whose sender was
 * added to the Cirqle numbers list after it was filed.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logRequestActivity, setRequestStatus } from '@/lib/requests/core'
import { CHAT_LOG_TABLE } from './chat-log'
import { LISTENER_KEYS, parseNumberList, phoneMatchKey, sentLabel } from './rules'
import { syncAction, syncNote, type SyncMessage } from './request-sync'

export const MESSAGE_ACTION = 'whatsapp_message'
export const REPLY_ACTION = 'whatsapp_reply'
/** Requests older than this are left for a person. */
const LOOK_BACK_DAYS = 30

/**
 * Every Cirqle phone number in comparable form: the listener's own list
 * (shared lines, personal numbers, freelancers) and active employees' saved phones.
 */
export async function cirqlePhoneKeys(admin: SupabaseClient, settings: Record<string, string>): Promise<Set<string>> {
  const keys = new Set(parseNumberList(settings[LISTENER_KEYS.staffNumbers]).numbers.keys())
  const { data } = await admin.from('employees').select('phone').eq('is_active', true)
  for (const e of (data || []) as { phone: string | null }[]) {
    const k = phoneMatchKey(e.phone)
    if (k) keys.add(k)
  }
  return keys
}

export interface SyncSummary { checked: number; archived: number; noted: number }

interface ActivityRow { request_id: string; action: string; detail: { messageId?: string; chatId?: string } | null }
interface LogRow { message_id: string; chat_id: string; sent_at: string; created_at: string; sender_phone: string | null; from_cirqle: boolean }

export async function syncWhatsAppRequests(
  admin: SupabaseClient, settings: Record<string, string>, o: { chatIds?: readonly string[] } = {},
): Promise<SyncSummary> {
  const out: SyncSummary = { checked: 0, archived: 0, noted: 0 }
  const since = new Date(Date.now() - LOOK_BACK_DAYS * 86_400_000).toISOString()

  let q = admin.from('request_activity').select('request_id, action, detail')
    .eq('action', MESSAGE_ACTION).gte('created_at', since).limit(5000)
  if (o.chatIds?.length === 1) q = q.eq('detail->>chatId', o.chatIds[0])
  const { data: acts } = await q
  const wanted = o.chatIds ? new Set(o.chatIds) : null
  const byRequest = new Map<string, { chatId: string; messageIds: string[] }>()
  for (const a of (acts || []) as ActivityRow[]) {
    const chatId = a.detail?.chatId, messageId = a.detail?.messageId
    if (!chatId || !messageId || (wanted && !wanted.has(chatId))) continue
    const r = byRequest.get(a.request_id) ?? { chatId, messageIds: [] }
    r.messageIds.push(messageId)
    byRequest.set(a.request_id, r)
  }
  if (!byRequest.size) return out

  // Only requests nobody has touched in Cirqle App: still New, not archived, no task.
  const { data: reqs } = await admin.from('task_requests').select('id')
    .in('id', [...byRequest.keys()]).eq('status', 'submitted').is('archived_at', null).is('promoted_task_id', null)
  const open = ((reqs || []) as { id: string }[]).map(r => r.id)
  if (!open.length) return out

  const chatIds = [...new Set(open.map(id => byRequest.get(id)!.chatId))]
  const [{ data: log }, { data: noted }, { data: decided }, cirqle] = await Promise.all([
    admin.from(CHAT_LOG_TABLE).select('message_id, chat_id, sent_at, created_at, sender_phone, from_cirqle')
      .in('chat_id', chatIds).gte('sent_at', since).limit(10000),
    admin.from('request_activity').select('request_id').eq('action', REPLY_ACTION).in('request_id', open),
    // A status change (it was unarchived, say) or a keep note means a person has decided: hands off.
    admin.from('request_activity').select('request_id, action, detail').in('action', ['status_changed', 'note']).in('request_id', open),
    cirqlePhoneKeys(admin, settings),
  ])
  const rows = (log || []) as LogRow[]
  // By today's list, not by what was known when the message arrived.
  const isCirqle = (r: LogRow) => r.from_cirqle || (!!r.sender_phone && cirqle.has(phoneMatchKey(r.sender_phone)))
  const byMessage = new Map(rows.map(r => [r.message_id, r]))
  const cirqleTimes = new Map<string, number[]>()
  for (const r of rows) {
    if (!isCirqle(r)) continue
    const list = cirqleTimes.get(r.chat_id) ?? []
    list.push(Date.parse(r.sent_at))
    cirqleTimes.set(r.chat_id, list)
  }
  const replyNoted = new Set(((noted || []) as { request_id: string }[]).map(n => n.request_id))
  const held = new Set(((decided || []) as { request_id: string; action: string; detail: { keep?: boolean } | null }[])
    .filter(d => d.action === 'status_changed' || d.detail?.keep === true).map(d => d.request_id))

  for (const id of open) {
    const { chatId, messageIds } = byRequest.get(id)!
    const messages: SyncMessage[] = []
    for (const mid of messageIds) {
      const r = byMessage.get(mid)
      if (r) messages.push({ sentAtMs: Date.parse(r.sent_at), arrivedAtMs: Date.parse(r.created_at), fromCirqle: isCirqle(r) })
    }
    // A message missing from the chat log cannot be judged: leave the request alone.
    if (messages.length !== messageIds.length) continue
    out.checked++
    const action = syncAction({ messages, replyNoted: replyNoted.has(id), held: held.has(id) }, cirqleTimes.get(chatId) ?? [])
    if (action.action === 'none') continue
    const note = syncNote(action, sentLabel)
    if (action.action === 'note-reply') {
      const ok = await logRequestActivity(admin, {
        requestId: id, actorType: 'system', actorLabel: 'WhatsApp listener', action: REPLY_ACTION, visibility: 'internal',
        detail: { message: note, chatId, repliedAt: new Date(action.repliedAtMs).toISOString() },
      })
      if (ok) out.noted++
      continue
    }
    // The reason first, so it is on the timeline even if the status change fails half-way.
    await logRequestActivity(admin, {
      requestId: id, actorType: 'system', actorLabel: 'WhatsApp listener', action: 'note', visibility: 'internal',
      detail: { message: note, why: action.why, chatId },
    })
    if (await setRequestStatus(admin, id, 'archived', { type: 'system', label: 'WhatsApp listener' })) out.archived++
  }
  return out
}
