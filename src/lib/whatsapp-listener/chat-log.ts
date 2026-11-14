/**
 * WhatsApp chat log — the rows behind the read-only chat view
 * (/dashboard/requests/whatsapp) and how they are shown.
 *
 * The listener files requests; this keeps the conversation around them, for
 * chats on the allow-list only. Nothing here sends anything to WhatsApp.
 *
 * Pure and dependency-free: the webhook does the writing, the page the reading.
 */

import { MAX_FILE_BYTES } from '@/lib/shortcut/whatsapp-capture'
import { isCapturableType, isVoiceOrPhoto, type ListenerMessage } from './rules'

export const CHAT_LOG_TABLE = 'whatsapp_chat_messages'
/** Messages shown per page of a chat, newest last. */
export const CHAT_PAGE_SIZE = 100

/** Gateway events that carry a chat message: one that arrived, or one the listener number sent. */
export function isChatEvent(event: string): boolean {
  return event === 'message.received' || event === 'message.sent'
}

export interface ChatLogRow {
  message_id: string
  chat_id: string
  is_group: boolean
  sender_id: string | null
  sender_name: string | null
  sender_phone: string | null
  from_cirqle: boolean
  type: string
  body: string | null
  media_path: string | null
  media_mime: string | null
  media_note: string | null
  sent_at: string
}

export interface ChatMediaFile { bytes: ArrayBuffer; mime: string; kind: 'audio' | 'image' }

/**
 * The voice note or photo on a message, ready to store, or the reason there
 * is nothing to store. `null` for both when the message carries no such file.
 */
export function chatMedia(m: ListenerMessage): { file: ChatMediaFile | null; note: string | null } {
  if (!isVoiceOrPhoto(m.type)) return { file: null, note: null }
  const kind = m.type === 'image' ? 'image' : 'audio'
  const what = kind === 'image' ? 'Photo' : 'Voice note'
  if (!m.media?.dataBase64) return { file: null, note: `${what} not passed on by the gateway. Open WhatsApp to see it.` }
  const buf = Buffer.from(m.media.dataBase64, 'base64')
  if (buf.byteLength === 0 || buf.byteLength > MAX_FILE_BYTES) {
    return { file: null, note: `${what} too large to keep here. Open WhatsApp to see it.` }
  }
  return {
    file: {
      // A fresh ArrayBuffer: a Node Buffer may be a view onto a shared pool.
      bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      mime: m.media.mimetype.split(';')[0].trim() || (kind === 'image' ? 'image/jpeg' : 'audio/ogg'),
      kind,
    },
    note: null,
  }
}

/**
 * The row for one message, or null when it is not worth keeping (a sticker,
 * a reaction, a deleted message: types the listener does not read either).
 */
export function chatLogRow(
  m: ListenerMessage,
  o: { fromCirqle: boolean; mediaPath: string | null; mediaMime: string | null; mediaNote: string | null; nowMs: number },
): ChatLogRow | null {
  if (!isChatEvent(m.event) || !m.id || !m.chatId) return null
  if (!isCapturableType(m.type)) return null
  const body = m.body.trim()
  if (!body && !isVoiceOrPhoto(m.type)) return null
  // A clock far in the future would pin the message to the top of the chat for ever.
  const sent = m.sentAtMs && m.sentAtMs <= o.nowMs + 5 * 60_000 ? m.sentAtMs : o.nowMs
  return {
    message_id: m.id,
    chat_id: m.chatId,
    is_group: m.isGroup,
    sender_id: m.senderId || null,
    sender_name: m.senderName ? m.senderName.slice(0, 80) : null,
    sender_phone: m.senderPhone || null,
    from_cirqle: o.fromCirqle || m.fromMe || m.event === 'message.sent',
    type: m.type,
    body: body ? body.slice(0, 8000) : null,
    media_path: o.mediaPath,
    media_mime: o.mediaPath ? o.mediaMime : null,
    media_note: o.mediaPath ? null : o.mediaNote,
    sent_at: new Date(sent).toISOString(),
  }
}

// ── Showing a chat ──────────────────────────────────────────────────────────

/** One line for the chat list: what the last message was. */
export function messagePreview(m: { type: string; body: string | null }): string {
  const text = (m.body || '').replace(/\s+/g, ' ').trim()
  if (m.type === 'image') return text ? `Photo: ${text}` : 'Photo'
  if (isVoiceOrPhoto(m.type)) return 'Voice note'
  return text
}

/** Who to show as the sender: the saved name, else the end of the number, else a neutral word. */
export function senderLabel(m: { from_cirqle: boolean; sender_name: string | null; sender_phone: string | null }): string {
  if (m.sender_name) return m.sender_name
  if (m.sender_phone) return `…${m.sender_phone.slice(-4)}`
  return m.from_cirqle ? 'Cirqle' : 'Unknown'
}

/**
 * What a chat is called inside Cirqle: the client's name. Without a linked
 * client, the WhatsApp group name with its "@Cirqle" ending removed
 * ("Al Nahda@Cirqle" → "Al Nahda"); an internal group keeps its own name.
 */
export function chatDisplayName(groupName: string | null | undefined, client: string | null | undefined, chatId: string): string {
  const c = (client || '').trim()
  if (c) return c
  const g = (groupName || '').trim()
  return g.replace(/\s*@\s*cirqle\s*$/i, '').trim() || g || chatId
}

export interface ChatSummary {
  chatId: string
  /** The client's name, else the group name without "@Cirqle", else the chat id. */
  title: string
  client: string
  lastAt: string | null
  lastPreview: string
  lastFromCirqle: boolean
}

/**
 * The chat list: every chat on the allow-list, the most recently active
 * first, chats with nothing stored yet at the end in list order.
 * `recent` must be newest first.
 */
export function chatSummaries(
  groups: ReadonlyMap<string, string>,
  names: Readonly<Record<string, string>>,
  recent: readonly { chat_id: string; sent_at: string; type: string; body: string | null; from_cirqle: boolean }[],
): ChatSummary[] {
  const last = new Map<string, (typeof recent)[number]>()
  for (const r of recent) if (!last.has(r.chat_id)) last.set(r.chat_id, r)
  const rows = [...groups].map(([chatId, client]): ChatSummary => {
    const l = last.get(chatId)
    return {
      chatId,
      title: chatDisplayName(names[chatId], client, chatId),
      client,
      lastAt: l?.sent_at ?? null,
      lastPreview: l ? messagePreview(l) : '',
      lastFromCirqle: l?.from_cirqle ?? false,
    }
  })
  // Array.sort is stable, so chats with no messages keep their allow-list order.
  return rows.sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''))
}

/** The calendar day of a message in India, as YYYY-MM-DD: the server's own timezone must not move a message to another day. */
export function indiaDay(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
}

/** Messages (oldest first) split into days, each day's messages in order. */
export function groupByDay<T extends { sent_at: string }>(messages: readonly T[]): { day: string; messages: T[] }[] {
  const days: { day: string; messages: T[] }[] = []
  for (const m of messages) {
    const day = indiaDay(m.sent_at)
    const current = days[days.length - 1]
    if (current?.day === day) current.messages.push(m)
    else days.push({ day, messages: [m] })
  }
  return days
}

/** True for the database's "this table does not exist" errors: the migration has not been applied yet. */
export function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  return error.code === '42P01' || error.code === 'PGRST205' || /could not find the table|does not exist/i.test(error.message || '')
}
