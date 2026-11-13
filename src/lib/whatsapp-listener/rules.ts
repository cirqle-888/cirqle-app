/**
 * WhatsApp listener — rules for messages forwarded by a self-hosted OpenWA
 * gateway (github.com/rmyndharis/OpenWA) running on a SPARE number that sits
 * in client groups and only listens.
 *
 * READ THIS FIRST. OpenWA is an unofficial client. Using it breaks WhatsApp's
 * terms and the number can be banned without warning. This integration is
 * therefore built to limit the damage and the intrusion:
 *   · it never sends anything to WhatsApp (there is no send code here at all);
 *   · it is OFF until switched on in Settings;
 *   · it ignores every chat that is not on an explicit allow-list, and stores
 *     nothing from those chats except the chat id and when it was last seen;
 *   · the share shortcut (docs/WHATSAPP_CAPTURE.md) keeps working without it.
 *
 * Pure and dependency-free: parsing, signature check and the decision rules.
 * The payload shape follows OpenWA's docs/06-api-specification.md §6.6 as read
 * on 10 Nov 2026, parsed defensively because it has not been seen live.
 */

import { createHmac, timingSafeEqual } from 'crypto'

// ── Signature ───────────────────────────────────────────────────────────────

/** OpenWA signs the exact body bytes: `X-OpenWA-Signature: sha256=<hex HMAC-SHA256>`. */
export function verifySignature(rawBody: string, header: string | null | undefined, secret: string): boolean {
  if (!secret || !header) return false
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`)
  const got = Buffer.from(header.trim())
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  return expected.length === got.length && timingSafeEqual(expected, got)
}

// ── Payload ─────────────────────────────────────────────────────────────────

export interface ListenerMedia {
  mimetype: string
  filename: string
  /** Base64 bytes when OpenWA sent them inline; null when it left them out. */
  dataBase64: string | null
  omitted: boolean
}

export interface ListenerMessage {
  event: string
  sessionId: string
  id: string
  chatId: string
  isGroup: boolean
  fromMe: boolean
  type: string
  body: string
  /** Who wrote it: the group participant for a group message, else the chat. */
  senderId: string
  /** Last 10 digits of the sender's phone when it can be known, else ''. */
  senderPhone: string
  senderName: string
  media: ListenerMedia | null
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

function phoneDigits(id: string): string {
  // Only real phone-number ids carry a phone. `@lid` ids are opaque.
  if (!/@(c\.us|s\.whatsapp\.net)$/.test(id)) return ''
  const d = id.replace(/@.*$/, '').replace(/\D/g, '')
  return d.length > 10 ? d.slice(-10) : d
}

/** Reads one OpenWA delivery. Returns null when it is not a usable message event. */
export function parseEnvelope(payload: unknown): ListenerMessage | null {
  const env = obj(payload)
  const data = obj(env.data)
  const event = str(env.event)
  const id = str(data.id)
  const chatId = str(data.chatId) || str(data.from)
  if (!event || !id || !chatId) return null

  const isGroup = data.isGroup === true || str(data.kind) === 'group' || chatId.endsWith('@g.us')
  const contact = obj(data.contact)
  const senderId = isGroup
    ? str(data.author) || str(data.participant) || str(contact.id) || str(data.from)
    : str(data.from) || chatId
  // `senderPhone` is set for hidden-number (@lid) senders; `contact.number` when the gateway knows it.
  const rawPhone = (str(data.senderPhone) || str(contact.number)).replace(/\D/g, '')
  const senderPhone = rawPhone ? (rawPhone.length > 10 ? rawPhone.slice(-10) : rawPhone) : phoneDigits(senderId)

  const m = obj(data.media)
  const media: ListenerMedia | null = Object.keys(m).length
    ? {
        mimetype: str(m.mimetype),
        filename: str(m.filename),
        dataBase64: str(m.data) || null,
        omitted: m.omitted === true || !str(m.data),
      }
    : null

  return {
    event,
    sessionId: str(env.sessionId),
    id,
    chatId,
    isGroup,
    fromMe: data.fromMe === true,
    type: str(data.type).toLowerCase() || 'unknown',
    body: str(data.body),
    senderId,
    senderPhone,
    senderName: str(contact.pushName) || str(contact.pushname) || str(contact.name) || str(contact.shortName) || str(data.notifyName),
    media,
  }
}

// ── Allow-list ──────────────────────────────────────────────────────────────

export const LISTENER_KEYS = {
  enabled: 'whatsapp_listener_enabled',
  groups: 'whatsapp_listener_groups',
  /** 'off' = capture every message that is not an acknowledgement, without asking the AI. */
  aiFilter: 'whatsapp_listener_ai_filter',
  seen: 'whatsapp_listener_seen',
  /** ISO time of the last signed delivery from the gateway, of any kind. */
  lastHeard: 'whatsapp_listener_last_heard',
  /** Last session status the gateway reported, as `<status> @ <ISO time>`. */
  session: 'whatsapp_listener_session',
} as const

/** Rows the listener writes itself. The Settings page must never save its stale copy over them. */
export const LISTENER_SERVER_KEYS: ReadonlySet<string> = new Set([LISTENER_KEYS.seen, LISTENER_KEYS.lastHeard, LISTENER_KEYS.session])

export function listenerEnabled(settings: Record<string, string | undefined>): boolean {
  return (settings[LISTENER_KEYS.enabled] || '').trim().toLowerCase() === 'on'
}

/** The AI chatter filter is on unless switched off. */
export function aiFilterOn(settings: Record<string, string | undefined>): boolean {
  return (settings[LISTENER_KEYS.aiFilter] || '').trim().toLowerCase() !== 'off'
}

// ── Is the listener still alive? ────────────────────────────────────────────

/** With no delivery of any kind for this long, something is probably wrong. */
export const SILENT_AFTER_HOURS = 24
/** How often the "last heard" time is rewritten at most. */
export const HEARD_WRITE_MINUTES = 10

export type ListenerHealth =
  | { state: 'off' }
  | { state: 'no-chats' }
  /** Switched on with chats listed, but the gateway has never called. */
  | { state: 'never' }
  | { state: 'ok'; hours: number }
  | { state: 'silent'; hours: number }

/**
 * Whether the gateway has gone quiet. A quiet day in every group looks the
 * same as a dead gateway from here, so `silent` means "check", not "broken".
 */
export function listenerHealth(settings: Record<string, string | undefined>, nowMs: number): ListenerHealth {
  if (!listenerEnabled(settings)) return { state: 'off' }
  if (parseGroupList(settings[LISTENER_KEYS.groups]).size === 0) return { state: 'no-chats' }
  const last = Date.parse(settings[LISTENER_KEYS.lastHeard] || '')
  if (!Number.isFinite(last)) return { state: 'never' }
  const hours = Math.max(0, Math.floor((nowMs - last) / 3_600_000))
  return hours >= SILENT_AFTER_HOURS ? { state: 'silent', hours } : { state: 'ok', hours }
}

/** True when the "last heard" row is missing or old enough to be worth rewriting. */
export function shouldWriteHeard(settings: Record<string, string | undefined>, nowMs: number): boolean {
  const last = Date.parse(settings[LISTENER_KEYS.lastHeard] || '')
  return !Number.isFinite(last) || nowMs - last >= HEARD_WRITE_MINUTES * 60_000
}

/** The status in a gateway `session.status` (or similar session) event, or null. */
export function parseSessionStatus(payload: unknown): string | null {
  const env = obj(payload)
  if (!str(env.event).startsWith('session.')) return null
  const data = obj(env.data)
  const status = str(data.status) || str(data.state) || str(env.event).slice('session.'.length)
  return status ? status.toLowerCase().slice(0, 60) : null
}

/**
 * A session status that means the spare number is no longer listening:
 * logged out, disconnected, banned or restricted. Matched loosely because the
 * gateway's exact wording has not been seen live.
 */
export function isBadSessionStatus(status: string): boolean {
  return /disconnect|logout|logged[_ ]?out|unpaired|banned|restrict|conflict|fail|closed|timeout|reconnect_loop/i.test(status)
}

/**
 * The allow-list, one chat per line:  `<chat id> = <client name>`
 *   120363021234567890@g.us = Sea Star Supermarket
 * Blank lines and lines starting with # are ignored. A chat that is not listed
 * is never captured.
 */
export function parseGroupList(text: string | null | undefined): Map<string, string> {
  const map = new Map<string, string>()
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const at = line.indexOf('=')
    const id = (at === -1 ? line : line.slice(0, at)).trim()
    const client = at === -1 ? '' : line.slice(at + 1).trim()
    if (/^[\w.+-]+@(g\.us|c\.us|s\.whatsapp\.net|lid)$/.test(id)) map.set(id, client)
  }
  return map
}

export interface SeenChat { at: string; by: string }
export const MAX_SEEN = 30

/** Chats that messaged the listener but are not on the allow-list: id, when, and who — never content. */
export function parseSeen(json: string | null | undefined): Record<string, SeenChat> {
  try {
    const v = JSON.parse(json || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, SeenChat>) : {}
  } catch {
    return {}
  }
}

export function addSeen(seen: Record<string, SeenChat>, chatId: string, by: string, at: string): Record<string, SeenChat> {
  const next = { ...seen, [chatId]: { at, by: by.slice(0, 40) } }
  const keep = Object.entries(next).sort((a, b) => (a[1].at < b[1].at ? 1 : -1)).slice(0, MAX_SEEN)
  return Object.fromEntries(keep)
}

// ── What to do with a message ───────────────────────────────────────────────

/** Message types that can carry a request. Stickers, reactions, polls, calls and deletions cannot. */
const CAPTURABLE = new Set(['text', 'chat', 'image', 'audio', 'voice', 'ptt'])

export function isCapturableType(type: string): boolean {
  return CAPTURABLE.has(type)
}

export function isVoiceOrPhoto(type: string): boolean {
  return type === 'image' || type === 'audio' || type === 'voice' || type === 'ptt'
}

const ACKS = new Set([
  'ok', 'okay', 'k', 'kk', 'okk', 'ok ok', 'ok sir', 'ok bro', 'ok thanks', 'ok thank you', 'okey', 'oke',
  'thanks', 'thank you', 'thankyou', 'thx', 'tnx', 'ty', 'thanks bro', 'thank you sir', 'welcome',
  'yes', 'yeah', 'ya', 'yep', 'no', 'done', 'noted', 'received', 'got it', 'super', 'nice', 'good', 'great',
  'fine', 'perfect', 'sure', 'hi', 'hello', 'hey', 'good morning', 'good night', 'gm', 'gn',
  'ശരി', 'ഓക്കേ', 'ഓകെ', 'നന്ദി', 'sheri', 'shari', 'aayi', 'ayi', 'mathi',
])

/**
 * A reply that carries no request: "ok", "thanks", a thumbs-up, a lone emoji.
 * Deliberately narrow — anything not clearly an acknowledgement goes on to the
 * AI check, and when in doubt a message is captured rather than dropped.
 */
export function isAcknowledgement(text: string): boolean {
  const t = (text || '').trim().toLowerCase()
  if (!t) return true
  // No letters or digits in any script: only emoji / punctuation.
  if (!/[\p{L}\p{N}]/u.test(t)) return true
  // \p{M} keeps vowel signs: without it Malayalam words lose letters and never match.
  const bare = t.replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
  return ACKS.has(bare)
}

/** Messages from the same person in the same chat within this window become one request. */
export const BURST_MINUTES = 10

export type ListenerDecision =
  | { action: 'ignore'; reason: 'disabled' | 'not-a-message' | 'from-us' | 'not-listed' | 'type' | 'staff' | 'duplicate' | 'acknowledgement' | 'not-a-request' }
  | { action: 'append' }
  | { action: 'file' }

/**
 * The decision, given everything that had to be looked up.
 *
 * `looksLikeRequest` is only consulted for a text message that starts a new
 * request. Voice notes and photos are always captured (they are rarely
 * chatter, and a missed price list costs more than a spare inbox item), and a
 * message that follows the same person's recent request is appended to it
 * without asking, because "need it by Friday" only makes sense in context.
 */
export function decide(input: {
  enabled: boolean
  message: ListenerMessage
  listed: boolean
  fromStaff: boolean
  duplicate: boolean
  hasRecentRequest: boolean
  looksLikeRequest: boolean | null
}): ListenerDecision {
  const m = input.message
  if (!input.enabled) return { action: 'ignore', reason: 'disabled' }
  if (m.event !== 'message.received') return { action: 'ignore', reason: 'not-a-message' }
  if (m.fromMe) return { action: 'ignore', reason: 'from-us' }
  if (!input.listed) return { action: 'ignore', reason: 'not-listed' }
  if (!isCapturableType(m.type)) return { action: 'ignore', reason: 'type' }
  if (input.fromStaff) return { action: 'ignore', reason: 'staff' }
  if (input.duplicate) return { action: 'ignore', reason: 'duplicate' }

  const voiceOrPhoto = isVoiceOrPhoto(m.type)
  if (!voiceOrPhoto && isAcknowledgement(m.body)) return { action: 'ignore', reason: 'acknowledgement' }
  if (input.hasRecentRequest) return { action: 'append' }
  if (!voiceOrPhoto && input.looksLikeRequest === false) return { action: 'ignore', reason: 'not-a-request' }
  return { action: 'file' }
}

/** Text added to an existing request when a follow-up message arrives. */
export function appendedDescription(existing: string | null | undefined, addition: string): string {
  const base = (existing || '').trimEnd()
  const add = addition.trim()
  if (!add) return base
  return `${base}\n\n— later —\n${add}`.slice(0, 12000)
}
