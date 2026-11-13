/**
 * WhatsApp listener — what happens to one message from the OpenWA gateway.
 *
 * Every lookup and side effect comes in through `deps`, so the whole flow is
 * tested without a database, storage or AI (see handle.test.ts).
 *
 * Outcomes: the message is ignored (with a reason), appended to the same
 * person's recent request, or filed as a new request. It never sends
 * anything back to WhatsApp.
 */

import {
  buildDescription, collectParts, combinedText, fallbackTitle, partLinks, MAX_FILE_BYTES,
  type CaptureDeps, type CapturedPart, type SharedFile,
} from '@/lib/shortcut/whatsapp-capture'
import { appendedDescription, decide, isVoiceOrPhoto, type ListenerMessage } from './rules'

export interface RecentRequest {
  id: string
  ref: string
  description: string | null
  extraLinks: { label: string; url: string }[]
}

export interface ListenerDeps extends Pick<CaptureDeps, 'transcribe' | 'readImage' | 'store' | 'parse'> {
  enabled: boolean
  /** Allow-listed chats: chat id → client name ('' when the line names no client). */
  groups: ReadonlyMap<string, string>
  /** Is this sender Cirqle (a listed Cirqle number or an active employee's phone)? */
  isStaffPhone: (phone: string) => Promise<boolean>
  isDuplicate: (messageId: string) => Promise<boolean>
  /** The same sender's request from this chat, filed in the last few minutes and still untouched. */
  recentRequest: (chatId: string, senderId: string) => Promise<RecentRequest | null>
  /** Is this text a work request? null = could not tell. */
  looksLikeRequest: (text: string) => Promise<boolean | null>
  file: (request: {
    title: string; client?: string; service?: string; dueDate?: string; notes: string
    extraLinks: { label: string; url: string }[]
  }) => Promise<{ ok: boolean; error?: string; id?: string; ref?: string; title?: string; client?: string | null }>
  append: (requestId: string, change: { description: string; extraLinks: { label: string; url: string }[] }) => Promise<boolean>
  /** Records the message against the request: the duplicate check and the burst lookup both read this. */
  logMessage: (requestId: string, message: ListenerMessage, summary: string) => Promise<void>
  /** Notes that an unlisted chat was seen (id, sender name, time — never content). */
  recordSeen: (chatId: string, by: string) => Promise<void>
  notify: (info: { ref: string; title: string; client: string | null; needsListening: boolean }) => Promise<void>
}

export type ListenerOutcome =
  | { result: 'ignored'; reason: string }
  | { result: 'appended'; ref: string }
  | { result: 'filed'; ref: string }
  | { result: 'failed'; error: string }

function mediaFile(m: ListenerMessage): { file: SharedFile | null; note: string | null } {
  if (!isVoiceOrPhoto(m.type)) return { file: null, note: null }
  const what = m.type === 'image' ? 'photo' : 'voice note'
  if (!m.media || !m.media.dataBase64) {
    return { file: null, note: `A ${what} was sent but the gateway did not pass it on. Open the WhatsApp chat to see it.` }
  }
  const bytes = Buffer.from(m.media.dataBase64, 'base64')
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) {
    return { file: null, note: `A ${what} was sent but it is too large to keep here. Open the WhatsApp chat to see it.` }
  }
  const fallbackName = m.type === 'image' ? 'photo.jpg' : 'voice-note.ogg'
  return {
    file: {
      name: m.media.filename || fallbackName,
      type: m.media.mimetype.split(';')[0].trim() || (m.type === 'image' ? 'image/jpeg' : 'audio/ogg'),
      // A fresh ArrayBuffer: a Node Buffer may be a view onto a shared pool.
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    },
    note: null,
  }
}

export async function handleListenerMessage(m: ListenerMessage, deps: ListenerDeps): Promise<ListenerOutcome> {
  const listed = deps.groups.has(m.chatId)

  // Cheap exits first, so an unlisted or disabled chat costs no lookups.
  const early = decide({ enabled: deps.enabled, message: m, listed, fromStaff: false, duplicate: false, hasRecentRequest: false, looksLikeRequest: null })
  if (early.action === 'ignore' && ['disabled', 'not-a-message', 'from-us', 'type', 'acknowledgement'].includes(early.reason)) {
    return { result: 'ignored', reason: early.reason }
  }
  if (!listed) {
    await deps.recordSeen(m.chatId, m.senderName).catch(() => {})
    return { result: 'ignored', reason: 'not-listed' }
  }

  const [fromStaff, duplicate] = await Promise.all([
    m.senderPhone ? deps.isStaffPhone(m.senderPhone).catch(() => false) : Promise.resolve(false),
    deps.isDuplicate(m.id).catch(() => false),
  ])
  if (fromStaff) return { result: 'ignored', reason: 'staff' }
  if (duplicate) return { result: 'ignored', reason: 'duplicate' }

  const recent = await deps.recentRequest(m.chatId, m.senderId).catch(() => null)
  const voiceOrPhoto = isVoiceOrPhoto(m.type)
  // Only a text message that would START a request is put to the AI check.
  const looks = !recent && !voiceOrPhoto ? await deps.looksLikeRequest(m.body).catch(() => null) : null

  const decision = decide({ enabled: deps.enabled, message: m, listed, fromStaff, duplicate, hasRecentRequest: !!recent, looksLikeRequest: looks })
  if (decision.action === 'ignore') return { result: 'ignored', reason: decision.reason }

  const { file, note } = mediaFile(m)
  const collected = file ? await collectParts([file], deps) : { parts: [] as CapturedPart[], skipped: [] as string[] }
  const parts = collected.parts
  const message = [m.body, note, ...collected.skipped.map(s => `Not kept: ${s}`)].filter(Boolean).join('\n')
  const client = deps.groups.get(m.chatId) || ''
  const sender = m.senderName || (m.senderPhone ? `…${m.senderPhone.slice(-4)}` : '')
  const summary = (combinedText(m.body, parts) || (voiceOrPhoto ? `(${m.type})` : '')).slice(0, 200)

  if (decision.action === 'append' && recent) {
    const addition = buildDescription({ message, parts }).split('\n').slice(1).join('\n') // drop the "From WhatsApp" line
    const ok = await deps.append(recent.id, {
      description: appendedDescription(recent.description, addition),
      extraLinks: [...recent.extraLinks, ...partLinks(parts, recent.extraLinks.length + 1)].slice(0, 10),
    })
    if (!ok) return { result: 'failed', error: `Could not add the message to ${recent.ref}.` }
    await deps.logMessage(recent.id, m, summary)
    return { result: 'appended', ref: recent.ref }
  }

  const text = combinedText(m.body, parts)
  const parsed = text ? await deps.parse(text).catch(() => ({} as Awaited<ReturnType<ListenerDeps['parse']>>)) : {}
  const filed = await deps.file({
    title: (parsed.title || '').trim() || fallbackTitle(text, parts),
    // The allow-list names the client for this chat; that is more reliable than a guess from the text.
    client: client || parsed.client,
    service: parsed.service,
    dueDate: parsed.dueDate,
    notes: buildDescription({ group: client ? `${client} ${m.isGroup ? 'group' : 'chat'}` : m.isGroup ? 'group' : 'chat', sender, message, parts }),
    extraLinks: partLinks(parts),
  })
  if (!filed.ok || !filed.id) return { result: 'failed', error: filed.error || 'Could not file the request.' }

  await deps.logMessage(filed.id, m, summary)
  await deps.notify({
    ref: filed.ref || '', title: filed.title || '', client: filed.client ?? (client || null),
    needsListening: parts.some(p => p.unread),
  }).catch(() => {})
  return { result: 'filed', ref: filed.ref || '' }
}
