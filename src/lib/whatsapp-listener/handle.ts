/**
 * WhatsApp listener — what happens to one message from the OpenWA gateway.
 *
 * Every lookup and side effect comes in through `deps`, so the whole flow is
 * tested without a database, storage or AI (see handle.test.ts).
 *
 * Outcomes: the message is ignored (with a reason), appended to the same
 * person's recent request, or filed as a new request. It never sends
 * anything back to WhatsApp.
 *
 * Two things keep the inbox honest when the gateway was off and is catching up
 * (rules.ts, LATE_AFTER_HOURS): a late message Cirqle has already answered in
 * the chat is not filed at all, and one that is filed says when it was really
 * sent and takes no due date from words like "tomorrow".
 */

import {
  buildDescription, collectParts, combinedText, fallbackTitle, partLinks, MAX_FILE_BYTES,
  type CaptureDeps, type CapturedPart, type SharedFile,
} from '@/lib/shortcut/whatsapp-capture'
import { decide, isLateMessage, isVoiceOrPhoto, sentLabel, type ListenerMessage } from './rules'

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
  /**
   * The same sender's request from this chat that is still untouched and whose messages were
   * SENT within a few minutes of this one (by WhatsApp's clock, not by when they reached us).
   */
  recentRequest: (chatId: string, senderId: string, sentAtMs: number | null) => Promise<RecentRequest | null>
  /** Has anyone from Cirqle written in this chat after this time? Only asked for a message that arrived late. */
  answeredSince: (chatId: string, sentAtMs: number) => Promise<boolean>
  /** Is this text a work request? null = could not tell. */
  looksLikeRequest: (text: string) => Promise<boolean | null>
  file: (request: {
    title: string; client?: string; service?: string; dueDate?: string; notes: string
    extraLinks: { label: string; url: string }[]
  }) => Promise<{ ok: boolean; error?: string; id?: string; ref?: string; title?: string; client?: string | null }>
  /** Adds a follow-up to a request as it stands now (rules.ts, appendChange). */
  append: (requestId: string, addition: { text: string; links: { label: string; url: string }[] }) => Promise<boolean>
  /**
   * Several photos sent together arrive at the same instant, and each can start its own request
   * before it sees the others. Called after filing: if an earlier request from the same burst
   * exists, this one is folded into it and its ref is returned; otherwise null.
   */
  mergeDuplicate: (requestId: string, message: ListenerMessage) => Promise<string | null>
  /** The clock, so tests can set it. */
  now?: () => number
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

  // A listed group with no client is one of Cirqle's own (Accounts, Creative, Flyer): it is on the
  // list so staff can read it in the chat view, and nothing said in it is a client's request.
  if (m.isGroup && !deps.groups.get(m.chatId)) return { result: 'ignored', reason: 'internal-group' }

  const [fromStaff, duplicate] = await Promise.all([
    m.senderPhone ? deps.isStaffPhone(m.senderPhone).catch(() => false) : Promise.resolve(false),
    deps.isDuplicate(m.id).catch(() => false),
  ])
  if (fromStaff) return { result: 'ignored', reason: 'staff' }
  if (duplicate) return { result: 'ignored', reason: 'duplicate' }

  const late = isLateMessage(m.sentAtMs, deps.now ? deps.now() : Date.now())
  // If the check itself fails the message is filed: a spare inbox item costs less than a lost request.
  const answered = late && m.sentAtMs ? await deps.answeredSince(m.chatId, m.sentAtMs).catch(() => false) : false
  const recent = answered ? null : await deps.recentRequest(m.chatId, m.senderId, m.sentAtMs).catch(() => null)
  const voiceOrPhoto = isVoiceOrPhoto(m.type)
  // Only a text message that would START a request is put to the AI check.
  const looks = !answered && !recent && !voiceOrPhoto ? await deps.looksLikeRequest(m.body).catch(() => null) : null

  const decision = decide({ enabled: deps.enabled, message: m, listed, fromStaff, duplicate, hasRecentRequest: !!recent, looksLikeRequest: looks, answered })
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
    const ok = await deps.append(recent.id, { text: addition, links: partLinks(parts) })
    if (!ok) return { result: 'failed', error: `Could not add the message to ${recent.ref}.` }
    await deps.logMessage(recent.id, m, summary)
    return { result: 'appended', ref: recent.ref }
  }

  const text = combinedText(m.body, parts)
  const parsed = text ? await deps.parse(text).catch(() => ({} as Awaited<ReturnType<ListenerDeps['parse']>>)) : {}
  // A voice note with no typed words: the only text is the AI's hearing of Malayalam speech, which is
  // often wrong. It stays in the request to be checked against the recording, but it is not the title.
  const spokenOnly = !m.body.trim() && parts.some(p => p.kind === 'audio')
  const lateNote = late && m.sentAtMs ? `Sent ${sentLabel(m.sentAtMs)}. It reached Cirqle App late, so check the chat for what happened since.` : null
  const filed = await deps.file({
    title: spokenOnly ? fallbackTitle('', parts) : (parsed.title || '').trim() || fallbackTitle(text, parts),
    // The allow-list names the client for this chat; that is more reliable than a guess from the text.
    client: client || parsed.client,
    service: parsed.service,
    // "Tomorrow" in a message that is days old would be counted from today: leave the date to a person.
    dueDate: late ? undefined : parsed.dueDate,
    notes: buildDescription({
      group: client ? `${client} ${m.isGroup ? 'group' : 'chat'}` : m.isGroup ? 'group' : 'chat', sender,
      message: [lateNote, message].filter(Boolean).join('\n'), parts,
    }),
    extraLinks: partLinks(parts),
  })
  if (!filed.ok || !filed.id) return { result: 'failed', error: filed.error || 'Could not file the request.' }

  await deps.logMessage(filed.id, m, summary)
  const mergedInto = await deps.mergeDuplicate(filed.id, m).catch(() => null)
  if (mergedInto) return { result: 'appended', ref: mergedInto }
  await deps.notify({
    ref: filed.ref || '', title: filed.title || '', client: filed.client ?? (client || null),
    needsListening: parts.some(p => p.unread),
  }).catch(() => {})
  return { result: 'filed', ref: filed.ref || '' }
}
