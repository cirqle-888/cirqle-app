import { randomUUID } from 'crypto'
import { after, NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server'
import { createRequest } from '@/lib/shortcut/actions'
import { logRequestActivity, setRequestStatus } from '@/lib/requests/core'
import { aiParse } from '@/lib/ai/request-capture'
import { callGroqJSON } from '@/lib/ai/groq'
import { transcribeAudio, translateAudio } from '@/lib/ai/transcribe'
import { readImageText } from '@/lib/ai/vision'
import { notifyAdmins } from '@/lib/notifications/create'
import { safeStorageName, transcriptionFileName, type PartKind, type SharedFile } from '@/lib/shortcut/whatsapp-capture'
import { handleListenerMessage, type ListenerDeps, type RecentRequest } from '@/lib/whatsapp-listener/handle'
import { planOfferFromMessage } from '@/lib/whatsapp-listener/offer-plan-run'
import { STALE_HOURS } from '@/lib/whatsapp-listener/offer-plan'
import { isPaymentMessage, looksLikeEnquiry, paymentAmount } from '@/lib/whatsapp-listener/signals'
import { ACCESS_KEY, chatAlertTargets, parseAccess } from '@/lib/whatsapp-listener/insights'
import { departmentMembers, loadListenerContext } from '@/lib/whatsapp-listener/insights-run'
import { isApproval } from '@/lib/whatsapp-listener/flyer-desk'
import { finishApprovedFlyers } from '@/lib/whatsapp-listener/flyer-desk-run'
import { CHAT_LOG_TABLE, chatLogRow, chatMedia, isChatEvent, isMissingTable } from '@/lib/whatsapp-listener/chat-log'
import { cirqlePhoneKeys, syncWhatsAppRequests, MESSAGE_ACTION } from '@/lib/whatsapp-listener/request-sync-run'
import {
  addSeen, aiFilterOn, appendChange, isBadSessionStatus, isStaleStatus, listenerEnabled, parseEnvelope, parseGroupList, parseSeen,
  parseSessionStatus, phoneMatchKey, shouldWriteHeard, verifySignature,
  BURST_MINUTES, LISTENER_KEYS, type ListenerMessage,
} from '@/lib/whatsapp-listener/rules'

/**
 * WhatsApp listener webhook — receives messages from a self-hosted OpenWA
 * gateway on a spare, listen-only number and files requests from allow-listed
 * client chats. Setup and the risks: docs/WHATSAPP_LISTENER.md.
 *
 *   POST /api/webhooks/openwa
 *   X-OpenWA-Signature: sha256=<hex HMAC-SHA256 of the raw body>
 *
 * Fails closed: without OPENWA_WEBHOOK_SECRET every call is refused, and a
 * call with a bad signature never reaches the database. It is also off until
 * "WhatsApp listener" is switched on in Settings, and it only ever READS from
 * WhatsApp: nothing in this route sends a message.
 *
 * The reply goes back at once and the work runs afterwards, because
 * transcribing a voice note can take longer than the gateway waits before it
 * retries — and a retry racing the first attempt would file the request twice.
 */

export const maxDuration = 60

const BUCKET = 'chat-attachments'
const LINK_SECONDS = 365 * 24 * 60 * 60
const ACTION = MESSAGE_ACTION

const json = (body: unknown, status = 200) => NextResponse.json(body, { status })

async function loadSettings(admin: SupabaseClient): Promise<Record<string, string>> {
  const { data } = await admin.from('company_settings').select('key, value').like('key', 'whatsapp_listener_%')
  return Object.fromEntries((data || []).map((r: { key: string; value: string | null }) => [r.key, r.value ?? '']))
}

/**
 * Is this sender Cirqle? On the listener's own number list (shared lines,
 * personal numbers, freelancers) or an active employee's saved phone.
 */
async function isCirqleNumber(admin: SupabaseClient, settings: Record<string, string>, phone: string): Promise<boolean> {
  const key = phoneMatchKey(phone)
  if (!key) return false
  return (await cirqleKeysOnce(admin, settings)).has(key)
}

/** One message asks "is this Cirqle?" several times: the numbers are read once per delivery. */
const keysBySettings = new WeakMap<Record<string, string>, Promise<Set<string>>>()
function cirqleKeysOnce(admin: SupabaseClient, settings: Record<string, string>): Promise<Set<string>> {
  let keys = keysBySettings.get(settings)
  if (!keys) { keys = cirqlePhoneKeys(admin, settings); keysBySettings.set(settings, keys) }
  return keys
}

type Links = { label: string; url: string }[]
const untouched = (r: { status?: unknown; archived_at?: unknown; promoted_task_id?: unknown } | null | undefined) =>
  !!r && r.status === 'submitted' && !r.archived_at && !r.promoted_task_id

/**
 * Adds a follow-up to a request as it stands NOW. Several messages from one burst are handled at
 * the same moment, each in its own invocation: writing back a description read earlier would let
 * the last one erase the others. So the write only lands if the row is unchanged since it was
 * read (its updated_at), and is retried on a fresh read when it is not.
 */
async function appendToRequest(admin: SupabaseClient, requestId: string, addition: { text: string; links: Links }): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data: row } = await admin.from('task_requests').select('description, extra_links, updated_at').eq('id', requestId).maybeSingle()
    if (!row) return false
    const change = appendChange(
      { description: row.description as string | null, extraLinks: Array.isArray(row.extra_links) ? (row.extra_links as Links) : [] },
      addition,
    )
    const now = new Date().toISOString()
    const { data: done, error } = await admin.from('task_requests').update({
      description: change.description,
      extra_links: change.extraLinks,
      last_external_activity_at: now, // re-flags it as new for staff
      updated_at: now,
    }).eq('id', requestId).eq('updated_at', row.updated_at as string).select('id')
    if (error) return false
    if (done?.length) return true
    await new Promise(r => setTimeout(r, 40 + Math.random() * 160))
  }
  return false
}

/** The burst window around a message's own send time, as ISO bounds. */
function burstWindow(sentAtMs: number | null): { from: string; to: string } {
  const at = sentAtMs ?? Date.now()
  return { from: new Date(at - BURST_MINUTES * 60_000).toISOString(), to: new Date(at + BURST_MINUTES * 60_000).toISOString() }
}

/**
 * Requests already holding a message from this sender in this chat that was SENT within the burst
 * window of `sentAtMs`. By send time, not arrival: when the gateway catches up after being off,
 * days of messages arrive in the same minute and must not be glued into one request.
 */
async function burstRequestIds(admin: SupabaseClient, chatId: string, senderId: string, sentAtMs: number | null): Promise<string[]> {
  const w = burstWindow(sentAtMs)
  const { data } = await admin.from(CHAT_LOG_TABLE).select('request_id')
    .eq('chat_id', chatId).eq('sender_id', senderId).not('request_id', 'is', null)
    .gte('sent_at', w.from).lte('sent_at', w.to).order('sent_at', { ascending: false }).limit(50)
  return [...new Set(((data || []) as { request_id: string }[]).map(r => r.request_id))]
}

/**
 * Photos sent together reach us at the same instant, and each can file its own request before
 * the others are visible. After filing, the newer request folds itself into the oldest one of the
 * same burst: its text and links move across, its messages are re-pointed, and it is archived.
 * The oldest never moves, so two requests cannot fold into each other.
 */
async function mergeIntoEarlier(admin: SupabaseClient, requestId: string, m: ListenerMessage): Promise<string | null> {
  // Give the other deliveries of the burst a moment to record their own requests.
  await new Promise(r => setTimeout(r, 900))
  const ids = (await burstRequestIds(admin, m.chatId, m.senderId, m.sentAtMs)).filter(id => id !== requestId)
  if (!ids.length) return null
  const { data } = await admin.from('task_requests')
    .select('id, ref_no, description, extra_links, status, archived_at, promoted_task_id').in('id', [...ids, requestId])
  const rows = (data || []) as { id: string; ref_no: number | null; description: string | null; extra_links: unknown; status: string; archived_at: string | null; promoted_task_id: string | null }[]
  const mine = rows.find(r => r.id === requestId)
  if (!mine || mine.ref_no == null) return null
  const earlier = rows.filter(r => r.id !== requestId && untouched(r) && r.ref_no != null && r.ref_no < (mine.ref_no as number))
    .sort((a, b) => (a.ref_no as number) - (b.ref_no as number))[0]
  if (!earlier) return null

  const text = (mine.description || '').split('\n').slice(1).join('\n') // drop the "From WhatsApp" line
  const ok = await appendToRequest(admin, earlier.id, { text, links: Array.isArray(mine.extra_links) ? (mine.extra_links as Links) : [] })
  if (!ok) return null
  const ref = `REQ-${String(earlier.ref_no).padStart(4, '0')}`
  await admin.from('request_activity').update({ request_id: earlier.id }).eq('request_id', requestId).eq('action', ACTION)
  await admin.from(CHAT_LOG_TABLE).update({ request_id: earlier.id }).eq('request_id', requestId).then(() => {}, () => {})
  await logRequestActivity(admin, {
    requestId, actorType: 'system', actorLabel: 'WhatsApp listener', action: 'note', visibility: 'internal',
    detail: { message: `Archived by the WhatsApp listener: sent together with ${ref}, so it was added to that request.` },
  })
  await setRequestStatus(admin, requestId, 'archived', { type: 'system', label: 'WhatsApp listener' })
  return ref
}

/**
 * Keeps the message for the read-only chat view (lib/whatsapp-listener/chat-log).
 * Only for chats on the allow-list, and only while the listener is on.
 *
 * Returns the storage path of the voice note or photo it kept, so the request
 * filing below links to the same file instead of storing a second copy.
 * Before the chat-log migration is applied this quietly does nothing.
 */
async function recordChatMessage(
  admin: SupabaseClient, settings: Record<string, string>, m: ListenerMessage, mediaText: MediaText,
): Promise<string | null> {
  if (!listenerEnabled(settings) || !parseGroupList(settings[LISTENER_KEYS.groups]).has(m.chatId)) return null
  const now = Date.now()
  const media = chatMedia(m)
  if (!chatLogRow(m, { fromCirqle: false, mediaPath: null, mediaMime: null, mediaNote: media.note, nowMs: now })) return null

  // A gateway retry: already kept, so do not store the file again.
  const existing = await admin.from(CHAT_LOG_TABLE).select('media_path').eq('message_id', m.id).maybeSingle()
  if (existing.error) {
    if (!isMissingTable(existing.error)) console.warn('[whatsapp-listener] chat log unavailable:', existing.error.message)
    return null
  }
  if (existing.data) return (existing.data.media_path as string | null) ?? null

  let mediaPath: string | null = null
  let mediaNote = media.note
  if (media.file) {
    const path = `whatsapp-chat/${new Date(now).toISOString().slice(0, 7)}/${randomUUID()}-${safeStorageName(m.media?.filename || '', media.file.kind)}`
    const { error } = await admin.storage.from(BUCKET).upload(path, media.file.bytes, { contentType: media.file.mime, upsert: false })
    if (error) mediaNote = 'Could not be stored. Open WhatsApp to see it.'
    else mediaPath = path
  }

  const fromCirqle = m.fromMe || m.event === 'message.sent'
    || (m.senderPhone ? await isCirqleNumber(admin, settings, m.senderPhone).catch(() => false) : false)
  const row = chatLogRow(m, { fromCirqle, mediaPath, mediaMime: media.file?.mime ?? null, mediaNote, nowMs: now })
  if (!row) return mediaPath
  const { error } = await admin.from(CHAT_LOG_TABLE).insert(row)
  // 23505: the same message arrived twice at once and the other delivery won.
  if (error && error.code !== '23505') console.warn('[whatsapp-listener] could not keep the message for the chat view:', error.message)
  // What the voice note says / what is written in the photo, so the chat can be
  // read, summarised and asked about like text. A separate write: before the
  // reports migration the column does not exist, and the message must still be kept.
  if (!error && media.file) {
    const text = await mediaText().catch(() => null)
    if (text) await admin.from(CHAT_LOG_TABLE).update({ media_text: text.slice(0, 8000) }).eq('message_id', m.id).then(() => {}, () => {})
  }
  return mediaPath
}

/**
 * A voice note as English text. Cirqle's clients speak Malayalam, which Whisper writes
 * as nonsense but translates usably, so the meaning in English is what is kept.
 * Falls back to plain transcription when translation is unavailable.
 */
async function transcribeVoice(audio: ArrayBuffer, fileName: string): Promise<string | null> {
  return (await translateAudio(audio, fileName)) ?? transcribeAudio(audio, fileName)
}

/** A message's voice note or photo as text, worked out at most once however many callers ask. */
type MediaText = () => Promise<string | null>
function mediaTextOnce(m: ListenerMessage): MediaText {
  let pending: Promise<string | null> | null = null
  return () => {
    if (!pending) {
      const { file } = chatMedia(m)
      pending = !file ? Promise.resolve(null)
        : file.kind === 'audio' ? transcribeVoice(file.bytes, transcriptionFileName(m.media?.filename || 'voice-note.ogg'))
          : readImageText(file.bytes, file.mime)
    }
    return pending
  }
}

function buildDeps(
  admin: SupabaseClient, settings: Record<string, string>, keptMediaPath: string | null = null, mediaText: MediaText | null = null,
): ListenerDeps {
  const month = new Date().toISOString().slice(0, 7)
  return {
    enabled: listenerEnabled(settings),
    groups: parseGroupList(settings[LISTENER_KEYS.groups]),

    // Cirqle is talking when the sender is on the listener's own number list
    // (shared lines, personal numbers, freelancers) or is an active employee's saved phone.
    isStaffPhone: phone => isCirqleNumber(admin, settings, phone),

    isDuplicate: async messageId => {
      const { data } = await admin.from('request_activity').select('id')
        .eq('action', ACTION).eq('detail->>messageId', messageId).limit(1)
      return !!data?.length
    },

    recentRequest: async (chatId, senderId, sentAtMs): Promise<RecentRequest | null> => {
      const ids = await burstRequestIds(admin, chatId, senderId, sentAtMs)
      if (!ids.length) return null
      // Only while nobody has picked it up: once staff act on it, a new message starts a new request.
      const { data } = await admin.from('task_requests')
        .select('id, ref_no, description, extra_links, status, archived_at, promoted_task_id').in('id', ids)
      const req = ((data || []) as { id: string; ref_no: number | null; description: string | null; extra_links: unknown; status: string; archived_at: string | null; promoted_task_id: string | null }[])
        .filter(untouched).sort((a, b) => (a.ref_no ?? 0) - (b.ref_no ?? 0))[0]
      if (!req) return null
      return {
        id: req.id,
        ref: `REQ-${String(req.ref_no ?? 0).padStart(4, '0')}`,
        description: req.description ?? null,
        extraLinks: Array.isArray(req.extra_links) ? (req.extra_links as Links) : [],
      }
    },

    answeredSince: async (chatId, sentAtMs) => {
      const { data } = await admin.from(CHAT_LOG_TABLE).select('from_cirqle, sender_phone')
        .eq('chat_id', chatId).gt('sent_at', new Date(sentAtMs).toISOString()).limit(500)
      const rows = (data || []) as { from_cirqle: boolean; sender_phone: string | null }[]
      if (rows.some(r => r.from_cirqle)) return true
      // A number added to the Cirqle list after its messages were stored still counts.
      const phones = rows.map(r => phoneMatchKey(r.sender_phone)).filter(Boolean)
      if (!phones.length) return false
      const cirqle = await cirqleKeysOnce(admin, settings)
      return phones.some(p => cirqle.has(p))
    },

    looksLikeRequest: async text => {
      // Filter switched off in Settings: capture everything that is not an acknowledgement.
      if (!aiFilterOn(settings)) return null
      const out = await callGroqJSON(
        'A design and marketing agency receives WhatsApp messages from its clients (shops, restaurants). ' +
        'Decide whether this message asks the agency to DO something or gives it material for work: a new design, ' +
        'a flyer or poster, a change or correction, a price or product list, a deadline, a question that needs an answer. ' +
        'Greetings, thanks, acknowledgements and small talk are not requests. If unsure, answer true. ' +
        'Respond with ONLY a JSON object: {"request": true} or {"request": false}.',
        text.slice(0, 2000),
      )
      return typeof out?.request === 'boolean' ? out.request : null
    },

    // A message carries one file, and the chat log has usually turned it into
    // text already: reuse that instead of paying the AI twice.
    transcribe: (audio, fileName) => (mediaText ? mediaText() : transcribeVoice(audio as ArrayBuffer, fileName)),
    readImage: (file: SharedFile) => (mediaText ? mediaText() : readImageText(file.bytes, file.type)),
    store: async (file: SharedFile, kind: PartKind) => {
      // The chat log already kept this file: link to that copy.
      if (keptMediaPath) {
        const kept = await admin.storage.from(BUCKET).createSignedUrl(keptMediaPath, LINK_SECONDS)
        if (kept.data?.signedUrl) return kept.data.signedUrl
      }
      const path = `whatsapp-capture/${month}/${randomUUID()}-${safeStorageName(file.name, kind)}`
      const { error } = await admin.storage.from(BUCKET).upload(path, file.bytes, {
        contentType: file.type || (kind === 'audio' ? 'audio/ogg' : 'image/jpeg'), upsert: false,
      })
      if (error) { console.warn('[whatsapp-listener] could not store the original:', error.message); return null }
      const { data } = await admin.storage.from(BUCKET).createSignedUrl(path, LINK_SECONDS)
      return data?.signedUrl ?? null
    },
    parse: text => aiParse(text),

    file: r => createRequest(admin, { ...r, unviewed: true }),

    append: (requestId, addition) => appendToRequest(admin, requestId, addition),
    mergeDuplicate: (requestId, m) => mergeIntoEarlier(admin, requestId, m),

    logMessage: async (requestId, m: ListenerMessage, summary) => {
      await admin.from('request_activity').insert({
        request_id: requestId,
        actor_type: 'client',
        actor_label: m.senderName || 'WhatsApp',
        action: ACTION,
        visibility: 'internal',
        detail: {
          message: summary, messageId: m.id, chatId: m.chatId, senderId: m.senderId, type: m.type,
          ...(m.sentAtMs ? { sentAt: new Date(m.sentAtMs).toISOString() } : {}),
        },
      })
      // Lets the chat view show which request a message became. Harmless before the chat-log migration.
      await admin.from(CHAT_LOG_TABLE).update({ request_id: requestId }).eq('message_id', m.id).then(() => {}, () => {})
    },

    recordSeen: async (chatId, by) => {
      const seen = parseSeen(settings[LISTENER_KEYS.seen])
      const last = seen[chatId]?.at
      // At most one write an hour per chat: this is a hint for the allow-list, not a log.
      if (last && Date.now() - new Date(last).getTime() < 3_600_000) return
      const next = addSeen(seen, chatId, by, new Date().toISOString())
      await admin.from('company_settings').upsert({ key: LISTENER_KEYS.seen, value: JSON.stringify(next) }, { onConflict: 'key' })
    },

    notify: async info => {
      await notifyAdmins({
        type: 'whatsapp_request',
        title: `New WhatsApp request — ${info.client || 'client not matched'}`,
        message: `${info.ref}: ${info.title}${info.needsListening ? ' (voice note needs listening)' : ''}`,
        link: '/dashboard/requests',
        sourceKey: `whatsapp_request:${info.ref}`,
      })
    },
  }
}

/**
 * Two things the owner is told about at once (rules: lib/whatsapp-listener/signals.ts):
 * a client saying a payment was made, and someone who is not a listed client asking
 * about a service. Only a Cirqle notification is raised: nothing is recorded as paid,
 * and an unlisted chat's words are looked at here and never stored.
 */
async function raiseSignals(m: ListenerMessage, deps: ListenerDeps, mediaText: MediaText): Promise<void> {
  if (!deps.enabled || m.fromMe) return
  // Caught up after the listener was off: old news.
  if (m.sentAtMs && Date.now() - m.sentAtMs > STALE_HOURS * 3_600_000) return
  const listed = deps.groups.has(m.chatId)
  if (!listed && (m.isGroup || m.type !== 'text' || !looksLikeEnquiry(m.body))) return
  // An internal Cirqle group (listed, no client): staff talking about payments is not a client paying.
  if (listed && m.isGroup && !deps.groups.get(m.chatId)) return
  if (m.senderPhone && await deps.isStaffPhone(m.senderPhone).catch(() => false)) return
  const who = m.senderName || (m.senderPhone ? `…${m.senderPhone.slice(-4)}` : 'Someone')

  if (!listed) {
    await notifyAdmins({
      type: 'whatsapp_request',
      title: 'New enquiry on WhatsApp',
      message: `${who}${m.senderName && m.senderPhone ? ` (…${m.senderPhone.slice(-4)})` : ''} is asking about a service on the Cirqle number. Reply in WhatsApp.`,
      link: '/dashboard',
      // Once a month per person, however many messages they send.
      sourceKey: `whatsapp_lead:${m.chatId}:${new Date().toISOString().slice(0, 7)}`,
    })
    return
  }

  // A payment screenshot says it in the picture, which the chat log has already read.
  const text = m.type === 'image' ? [m.body, await mediaText().catch(() => null)].filter(Boolean).join('\n') : m.type === 'text' ? m.body : ''
  if (!isPaymentMessage(text)) return
  const amount = paymentAmount(text)
  await notifyAdmins({
    type: 'whatsapp_pending',
    title: `Payment message — ${deps.groups.get(m.chatId) || 'client chat'}`,
    message: `${who} says a payment was made${amount ? ` (${amount})` : ''}. Check the bank, then record it against the invoice.`,
    link: `/dashboard/requests/whatsapp?chat=${encodeURIComponent(m.chatId)}`,
    sourceKey: `whatsapp_payment:${m.id}`,
  })
}

/** Notes that the gateway is alive. Any signed delivery counts, whatever it carries. */
async function recordHeard(admin: SupabaseClient, settings: Record<string, string>): Promise<void> {
  if (!shouldWriteHeard(settings, Date.now())) return
  await admin.from('company_settings')
    .upsert({ key: LISTENER_KEYS.lastHeard, value: new Date().toISOString() }, { onConflict: 'key' })
}

/** Stores the gateway's session status and raises an alert when the number stops listening. */
async function recordSession(admin: SupabaseClient, settings: Record<string, string>, status: string): Promise<void> {
  const before = (settings[LISTENER_KEYS.session] || '').split(' @ ')[0]
  const now = new Date().toISOString()
  await admin.from('company_settings')
    .upsert({ key: LISTENER_KEYS.session, value: `${status} @ ${now}` }, { onConflict: 'key' })
  if (!listenerEnabled(settings) || !isBadSessionStatus(status) || before === status) return
  await notifyAdmins({
    type: 'whatsapp_listener_down',
    title: 'The WhatsApp listener has stopped',
    message: `The gateway reports "${status}". Client messages are not being captured. Check OpenWA, relink the spare number if needed, and use the share shortcut meanwhile.`,
    link: '/dashboard/settings',
    // One alert per status change per day, however many times the gateway repeats it.
    sourceKey: `whatsapp_listener_down:${status}:${now.slice(0, 10)}`,
  })
}

export async function POST(req: NextRequest) {
  const secret = (process.env.OPENWA_WEBHOOK_SECRET || '').trim()
  if (secret.length < 16) {
    return json({ ok: false, error: 'WhatsApp listener is not set up (OPENWA_WEBHOOK_SECRET missing).' }, 503)
  }

  const raw = await req.text()
  if (!verifySignature(raw, req.headers.get('x-openwa-signature'), secret)) {
    return json({ ok: false, error: 'Bad signature.' }, 401)
  }

  let payload: unknown
  try { payload = JSON.parse(raw) } catch { return json({ ok: false, error: 'Invalid JSON.' }, 400) }

  const message = parseEnvelope(payload)
  if (!message || !isChatEvent(message.event)) {
    // Not a message (a test ping, a session event). It still proves the gateway is alive,
    // and a session event may say the number has stopped listening.
    // A late retry of an old status must not overwrite the current one or raise a false alarm.
    const status = isStaleStatus(payload, Date.now()) ? null : parseSessionStatus(payload)
    after(async () => {
      try {
        const admin = createAdminClient()
        const settings = await loadSettings(admin)
        await recordHeard(admin, settings)
        if (status) await recordSession(admin, settings, status)
      } catch (err) {
        console.error('[whatsapp-listener] could not record gateway status:', err)
      }
    })
    return json({ ok: true, result: 'ignored', reason: 'not-a-message' })
  }

  after(async () => {
    const admin = createAdminClient()
    try {
      const settings = await loadSettings(admin)
      await recordHeard(admin, settings).catch(() => {})
      // Keeping the conversation must never stop a request from being filed.
      const mediaText = mediaTextOnce(message)
      const keptMediaPath = await recordChatMessage(admin, settings, message, mediaText).catch(err => {
        console.warn('[whatsapp-listener] chat log failed:', err)
        return null
      })
      const deps = buildDeps(admin, settings, keptMediaPath, mediaText)
      // Cirqle wrote in a client's chat: the requests waiting there are brought up to date
      // (lib/whatsapp-listener/request-sync.ts). An internal Cirqle group has no client and no requests.
      const fromCirqle = message.fromMe || message.event === 'message.sent'
        || (message.senderPhone ? await deps.isStaffPhone(message.senderPhone).catch(() => false) : false)
      if (fromCirqle && deps.enabled && deps.groups.get(message.chatId)) {
        await syncWhatsAppRequests(admin, settings, { chatIds: [message.chatId] })
          .catch(err => console.warn('[whatsapp-listener] requests not brought up to date:', err))
      }
      // A message the listener number sent is part of the conversation, never a request.
      if (message.event !== 'message.received') return
      await raiseSignals(message, deps, mediaText).catch(err => console.warn('[whatsapp-listener] payment/enquiry check failed:', err))
      // The client's "ok" after a design: the flyer takes its offer title and its task is closed.
      if (deps.enabled && deps.groups.has(message.chatId) && message.type === 'text' && isApproval(message.body)
        && !(message.senderPhone && await deps.isStaffPhone(message.senderPhone).catch(() => false))) {
        await finishApprovedFlyers(admin, await loadListenerContext(admin), new Set([message.chatId]))
          .catch(err => console.warn('[whatsapp-listener] approved flyer not closed:', err))
      }
      // A supermarket's offer price list goes onto its social calendar instead of the Requests inbox.
      // If that cannot be done for any reason, the message is filed as a request as before.
      const chatAccess = parseAccess(settings[ACCESS_KEY])[message.chatId]
      const planned = await planOfferFromMessage(admin, message, {
        enabled: deps.enabled,
        clientName: deps.groups.get(message.chatId) || '',
        isStaffPhone: deps.isStaffPhone,
        ownerId: chatAccess?.owner ?? null,
        // Looked up only for a chat shared with a department: most messages need no extra query.
        tellIds: chatAlertTargets(chatAccess, chatAccess?.departments.length && !chatAccess.owner ? await departmentMembers(admin).catch(() => new Map()) : new Map()),
        mediaText,
      }).catch(err => {
        console.warn('[whatsapp-listener] offer list check failed:', err)
        return false
      })
      if (planned) return
      const outcome = await handleListenerMessage(message, deps)
      if (outcome.result === 'failed') throw new Error(outcome.error)
    } catch (err) {
      // The message is not lost from WhatsApp, but it did not reach the inbox: say so, without its content.
      console.error('[whatsapp-listener] failed:', err)
      await notifyAdmins({
        type: 'whatsapp_capture_failed',
        title: 'A WhatsApp message could not be captured',
        message: `From ${message.senderName || 'a client'} just now. Open WhatsApp to read it. (${err instanceof Error ? err.message.slice(0, 120) : 'error'})`,
        link: '/dashboard/requests',
        sourceKey: `whatsapp_capture_failed:${message.id}`,
      })
    }
  })

  return json({ ok: true, result: 'accepted' })
}
