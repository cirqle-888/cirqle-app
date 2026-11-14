/**
 * WhatsApp insights — the rules behind the smart layer over the chat log:
 *
 *   · who may see which chat (Settings → WhatsApp Listener),
 *   · the daily report and the open "pending" items the AI works out per chat,
 *   · who gets told when something is waiting on Cirqle,
 *   · what is handed to the AI when someone asks a question.
 *
 * Pure and dependency-free. The AI calls and the database live in
 * insights-run.ts. Nothing here, or there, sends anything to WhatsApp:
 * alerts go to people inside Cirqle only.
 */

import { isAcknowledgement, isVoiceOrPhoto } from './rules'

export const REPORT_TABLE = 'whatsapp_chat_reports'
/** company_settings key: JSON of chat id → who is responsible and who may see it. */
export const ACCESS_KEY = 'whatsapp_listener_access'

// ── Who may see a chat ──────────────────────────────────────────────────────

export interface ChatAccess {
  /** Employee id of the person responsible for this chat: sees it, and is told about pending items. */
  owner: string | null
  /** Employee ids the chat is also shared with. */
  viewers: string[]
  /** Open to everyone who can open the Requests inbox. */
  everyone: boolean
}

export const NO_ACCESS: ChatAccess = { owner: null, viewers: [], everyone: false }

export function parseAccess(json: string | null | undefined): Record<string, ChatAccess> {
  let v: unknown
  try { v = JSON.parse(json || '{}') } catch { return {} }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, ChatAccess> = {}
  for (const [chatId, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as { owner?: unknown; viewers?: unknown; everyone?: unknown }
    out[chatId] = {
      owner: typeof r.owner === 'string' && r.owner ? r.owner : null,
      viewers: Array.isArray(r.viewers) ? [...new Set(r.viewers.filter((x): x is string => typeof x === 'string' && !!x))] : [],
      everyone: r.everyone === true,
    }
  }
  return out
}

/** The settings text for the access table. Chats left on the default (admins only, nobody responsible) are dropped. */
export function serializeAccess(access: Readonly<Record<string, ChatAccess>>, listedChatIds: Iterable<string>): string {
  const out: Record<string, ChatAccess> = {}
  for (const id of listedChatIds) {
    const a = access[id]
    if (a && (a.owner || a.viewers.length || a.everyone)) out[id] = { owner: a.owner, viewers: a.viewers, everyone: a.everyone }
  }
  return JSON.stringify(out)
}

export interface Viewer { isAdmin: boolean; employeeId: string; canViewRequests: boolean }

/**
 * May this person read this chat? Admins always. Otherwise only the person
 * responsible, the people it is shared with, or — when the chat is opened to
 * everyone — anyone with the Requests inbox. A chat with no setting is
 * admins-only: client conversations are private until someone shares them.
 */
export function canSeeChat(viewer: Viewer | null, access: ChatAccess | undefined): boolean {
  if (!viewer) return false
  if (viewer.isAdmin) return true
  const a = access ?? NO_ACCESS
  if (a.owner === viewer.employeeId || a.viewers.includes(viewer.employeeId)) return true
  return a.everyone && viewer.canViewRequests
}

export function visibleChatIds(viewer: Viewer | null, chatIds: Iterable<string>, access: Readonly<Record<string, ChatAccess>>): Set<string> {
  const out = new Set<string>()
  for (const id of chatIds) if (canSeeChat(viewer, access[id])) out.add(id)
  return out
}

// ── What the AI reads ───────────────────────────────────────────────────────

export interface InsightMessage {
  sent_at: string
  sender_name: string | null
  sender_phone: string | null
  from_cirqle: boolean
  type: string
  body: string | null
  media_text?: string | null
}

/** Everything a message says, as text: its words, plus what a voice note says or a photo shows. */
export function messageText(m: Pick<InsightMessage, 'type' | 'body' | 'media_text'>): string {
  const body = (m.body || '').trim()
  const said = (m.media_text || '').trim()
  if (!isVoiceOrPhoto(m.type)) return body
  const what = m.type === 'image' ? 'Photo' : 'Voice note'
  const media = said ? `[${what}] ${said}` : `[${what}, not turned into text]`
  return body ? `${media}\n${body}` : media
}

const IST = 'Asia/Kolkata'
const stamp = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: IST, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * The conversation as lines the AI can read, oldest first:
 *   `14 Nov, 10:32 | CLIENT Rashid: need the flyer today`
 * Bounded: when it is too long the OLDEST lines are dropped, since the newest
 * decide what is still pending.
 */
export function transcript(messages: readonly InsightMessage[], maxChars = 9000): string {
  const lines = messages.map(m => {
    const who = m.sender_name || (m.sender_phone ? `…${m.sender_phone.slice(-4)}` : 'Unknown')
    const text = messageText(m).replace(/\s+/g, ' ').trim().slice(0, 600)
    return `${stamp(m.sent_at)} | ${m.from_cirqle ? 'CIRQLE' : 'CLIENT'} ${who}: ${text}`
  })
  let total = 0
  const kept: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length + 1
    if (total > maxChars) break
    kept.unshift(lines[i])
  }
  return kept.join('\n')
}

// ── The report ──────────────────────────────────────────────────────────────

export type WaitingOn = 'cirqle' | 'client'

export interface PendingItem {
  id: string
  /** One plain-English line: what is still open. */
  text: string
  /** Whose move it is. */
  waitingOn: WaitingOn
  /** The Cirqle person named for it in the chat, when one was. */
  who: string | null
  /** The India day (YYYY-MM-DD) it was first noticed. */
  since: string
}

export const REPORT_PROMPT =
  'You keep the follow-up list for Cirqle, a design and marketing agency in Kerala, India. ' +
  'You are given one WhatsApp chat between Cirqle staff (lines marked CIRQLE) and a client (lines marked CLIENT). ' +
  'Messages may be in Malayalam, Manglish (Malayalam in English letters) or English; voice notes and photos appear as text in [brackets]. ' +
  'You also get the list of items that were still open before these messages.\n\n' +
  'Work out:\n' +
  '1. "summary": 2 to 4 short plain-English sentences on what happened in these messages. Facts only, no advice.\n' +
  '2. "items": every item that is STILL open after the last message. Keep an earlier open item (with its same "id") unless the ' +
  'messages show it was done, delivered, answered or cancelled. Add new ones without an id. For each item:\n' +
  '   "text": one short plain-English line saying exactly what is needed (include product, size, date or amount when given),\n' +
  '   "waitingOn": "cirqle" when Cirqle must act next (do the work, reply, send a file, answer a question), ' +
  '"client" when the client must act next (send content, approve, pay, confirm),\n' +
  '   "who": the name of the Cirqle person asked or tagged for it, or null.\n' +
  'Greetings, thanks and small talk are never items. Do not invent work that was not asked for. If nothing is open, return an empty list.\n\n' +
  'Respond with ONLY a JSON object: {"summary": "...", "items": [{"id": "...", "text": "...", "waitingOn": "cirqle", "who": null}]}'

export function reportInput(o: { chatTitle: string; client: string; openItems: readonly PendingItem[]; transcript: string }): string {
  const open = o.openItems.length
    ? o.openItems.map(i => `- id ${i.id} | waiting on ${i.waitingOn}${i.who ? ` | ${i.who}` : ''} | ${i.text}`).join('\n')
    : '(none)'
  return `Chat: ${o.chatTitle}${o.client ? ` (client: ${o.client})` : ' (internal Cirqle chat)'}\n\nOpen before these messages:\n${open}\n\nMessages:\n${o.transcript}`
}

export const MAX_ITEMS_PER_CHAT = 20

/** Reads stored items (or anything shaped like them) back safely. */
export function parseItems(value: unknown): PendingItem[] {
  if (!Array.isArray(value)) return []
  const out: PendingItem[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const text = typeof r.text === 'string' ? r.text.replace(/\s+/g, ' ').trim() : ''
    if (!text || typeof r.id !== 'string' || !r.id) continue
    out.push({
      id: r.id,
      text: text.slice(0, 300),
      waitingOn: r.waitingOn === 'client' ? 'client' : 'cirqle',
      who: typeof r.who === 'string' && r.who.trim() ? r.who.trim().slice(0, 60) : null,
      since: typeof r.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.since) ? r.since : '',
    })
  }
  return out
}

/**
 * The AI's answer made safe to store. An item that carries an id from the
 * earlier list keeps that id and its "since" day; anything else is new and
 * gets a fresh id. Returns the ids that are new, so only those raise alerts.
 */
export function normalizeReport(
  ai: unknown,
  previous: readonly PendingItem[],
  o: { today: string; newId: () => string },
): { summary: string; items: PendingItem[]; newIds: string[] } {
  const a = (ai && typeof ai === 'object' ? ai : {}) as { summary?: unknown; items?: unknown }
  const summary = typeof a.summary === 'string' ? a.summary.replace(/\s+/g, ' ').trim().slice(0, 1200) : ''
  const before = new Map(previous.map(i => [i.id, i]))
  const used = new Set<string>()
  const items: PendingItem[] = []
  const newIds: string[] = []
  for (const raw of Array.isArray(a.items) ? a.items : []) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const text = typeof r.text === 'string' ? r.text.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
    if (!text) continue
    const kept = typeof r.id === 'string' && before.has(r.id) && !used.has(r.id) ? before.get(r.id)! : null
    const id = kept ? kept.id : o.newId()
    used.add(id)
    if (!kept) newIds.push(id)
    items.push({
      id,
      text,
      waitingOn: r.waitingOn === 'client' ? 'client' : 'cirqle',
      who: typeof r.who === 'string' && r.who.trim() && !/^(null|none|n\/a)$/i.test(r.who.trim()) ? r.who.trim().slice(0, 60) : null,
      since: kept?.since || o.today,
    })
    if (items.length >= MAX_ITEMS_PER_CHAT) break
  }
  return { summary, items, newIds }
}

// ── Who gets told ───────────────────────────────────────────────────────────

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9ഀ-ൿ\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3)

/**
 * Who should be told that an item is waiting on Cirqle.
 * The person named in the chat when their name matches exactly one active
 * employee; else the person responsible for the chat; else nobody in
 * particular (`[]`), which the caller sends to the admins.
 */
export function alertTargets(
  item: Pick<PendingItem, 'who'>,
  access: ChatAccess | undefined,
  employees: readonly { id: string; name: string }[],
): string[] {
  if (item.who) {
    const wanted = words(item.who)
    const matches = employees.filter(e => {
      const have = words(e.name)
      return wanted.length > 0 && wanted.some(w => have.includes(w))
    })
    if (matches.length === 1) return [matches[0].id]
  }
  return access?.owner ? [access.owner] : []
}

// ── The pending list ────────────────────────────────────────────────────────

export interface ReportRow {
  chat_id: string
  report_day: string
  summary: string
  items: unknown
  message_count: number
  covered_until: string | null
  updated_at: string
}

/** The newest report of each chat. `rows` in any order. */
export function latestReports<T extends Pick<ReportRow, 'chat_id' | 'report_day'>>(rows: readonly T[]): Map<string, T> {
  const out = new Map<string, T>()
  for (const r of rows) {
    const have = out.get(r.chat_id)
    if (!have || r.report_day > have.report_day) out.set(r.chat_id, r)
  }
  return out
}

export interface PendingLine extends PendingItem { chatId: string; days: number }

/** Whole days between two India days (YYYY-MM-DD). Never negative. */
export function daysBetween(fromDay: string, toDay: string): number {
  const a = Date.parse(`${fromDay}T00:00:00Z`), b = Date.parse(`${toDay}T00:00:00Z`)
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 86_400_000)) : 0
}

/** Every open item across the chats, the longest-waiting first. */
export function pendingLines(latest: ReadonlyMap<string, Pick<ReportRow, 'items'>>, today: string): PendingLine[] {
  const out: PendingLine[] = []
  for (const [chatId, r] of latest) {
    for (const i of parseItems(r.items)) out.push({ ...i, chatId, days: i.since ? daysBetween(i.since, today) : 0 })
  }
  return out.sort((a, b) => b.days - a.days || a.chatId.localeCompare(b.chatId))
}

// ── Asking a question ───────────────────────────────────────────────────────

/**
 * The chats a question is about: those whose client or group name shares a
 * distinctive word with it ("what is pending for Sea Star" → the Sea Star chat).
 * Words every chat name has (cirqle, group) do not count.
 */
export function chatsInQuestion(question: string, chats: readonly { chatId: string; title: string; client: string }[], max = 3): string[] {
  const common = new Set(['cirqle', 'group', 'works', 'official', 'team', 'the', 'and', 'for'])
  const asked = new Set(words(question))
  const scored = chats.map(c => {
    const own = new Set([...words(c.title), ...words(c.client)].filter(w => !common.has(w)))
    let score = 0
    for (const w of own) if (asked.has(w)) score++
    return { chatId: c.chatId, score }
  }).filter(c => c.score > 0)
  return scored.sort((a, b) => b.score - a.score).slice(0, max).map(c => c.chatId)
}

export const ASK_PROMPT =
  'You answer questions from staff of Cirqle, a design and marketing agency in Kerala, about its client WhatsApp chats. ' +
  'Use ONLY the notes given: per chat, the open items, recent daily summaries, recent messages and open requests. ' +
  'Answer in short, simple English. Start with the direct answer. When listing pending things, say for each whether it is ' +
  'waiting on Cirqle or on the client, and for how long when the notes say. ' +
  'If the notes do not contain the answer, say so plainly and do not guess. Never make up names, dates, prices or promises.'

// ── Clients still waiting for a reply ───────────────────────────────────────

/** A client message with no Cirqle reply after this long is worth a nudge. */
export const WAITING_AFTER_HOURS = 2
/** Older than this, it is history, not something to chase tonight. */
export const WAITING_MAX_HOURS = 72

export interface LastMessage {
  chat_id: string; message_id: string; from_cirqle: boolean; type: string; body: string | null; sent_at: string
}
export interface WaitingChat { chatId: string; messageId: string; since: string; hours: number }

/**
 * Chats where the client spoke last and Cirqle has not answered.
 * `messages` are recent ones from any chats, newest first. A closing "ok" or
 * thumbs-up from the client needs no answer, so it does not count.
 */
export function waitingChats(messages: readonly LastMessage[], nowMs: number): WaitingChat[] {
  const byChat = new Map<string, LastMessage[]>()
  for (const m of messages) (byChat.get(m.chat_id) ?? byChat.set(m.chat_id, []).get(m.chat_id)!).push(m)
  const out: WaitingChat[] = []
  for (const [chatId, list] of byChat) {
    const newest = list[0]
    if (!newest || newest.from_cirqle) continue
    if (!isVoiceOrPhoto(newest.type) && isAcknowledgement(newest.body || '')) continue
    // The first message of the run Cirqle has not answered: that is how long they have waited.
    let first = newest
    for (const m of list) { if (m.from_cirqle) break; first = m }
    const hours = (nowMs - Date.parse(first.sent_at)) / 3_600_000
    if (!Number.isFinite(hours) || hours < WAITING_AFTER_HOURS || hours > WAITING_MAX_HOURS) continue
    out.push({ chatId, messageId: first.message_id, since: first.sent_at, hours: Math.floor(hours) })
  }
  return out.sort((a, b) => b.hours - a.hours)
}

// ── The week in one note ────────────────────────────────────────────────────

/** Monday's note to the owner: how busy the chats were and what is still open. Null when there is nothing to say. */
export function weeklyDigest(
  week: readonly Pick<ReportRow, 'chat_id' | 'message_count'>[],
  latest: ReadonlyMap<string, Pick<ReportRow, 'items'>>,
  today: string,
  title: (chatId: string) => string,
): string | null {
  const perChat = new Map<string, number>()
  for (const r of week) perChat.set(r.chat_id, (perChat.get(r.chat_id) || 0) + (r.message_count || 0))
  const total = [...perChat.values()].reduce((a, b) => a + b, 0)
  const open = pendingLines(latest, today)
  if (!total && !open.length) return null
  const busiest = [...perChat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, n]) => `${title(id)} (${n})`)
  const ours = open.filter(l => l.waitingOn === 'cirqle')
  const oldest = ours[0]
  return [
    `Last 7 days: ${total} message${total === 1 ? '' : 's'} in ${perChat.size} chat${perChat.size === 1 ? '' : 's'}.`,
    busiest.length ? `Busiest: ${busiest.join(', ')}.` : '',
    ours.length
      ? `Waiting on Cirqle: ${ours.length}${oldest && oldest.days > 0 ? `, the oldest for ${oldest.days} day${oldest.days === 1 ? '' : 's'} (${title(oldest.chatId)})` : ''}.`
      : 'Nothing is waiting on Cirqle.',
    `Waiting on clients: ${open.length - ours.length}.`,
  ].filter(Boolean).join(' ')
}
