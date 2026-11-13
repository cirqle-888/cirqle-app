import { randomUUID } from 'crypto'
import { after, NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server'
import { createRequest } from '@/lib/shortcut/actions'
import { aiParse, normalizePhone } from '@/lib/ai/request-capture'
import { callGroqJSON } from '@/lib/ai/groq'
import { transcribeAudio } from '@/lib/ai/transcribe'
import { readImageText } from '@/lib/ai/vision'
import { notifyAdmins } from '@/lib/notifications/create'
import { safeStorageName, type PartKind, type SharedFile } from '@/lib/shortcut/whatsapp-capture'
import { handleListenerMessage, type ListenerDeps, type RecentRequest } from '@/lib/whatsapp-listener/handle'
import {
  addSeen, aiFilterOn, isBadSessionStatus, listenerEnabled, parseEnvelope, parseGroupList, parseSeen,
  parseSessionStatus, shouldWriteHeard, verifySignature,
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
const ACTION = 'whatsapp_message'

const json = (body: unknown, status = 200) => NextResponse.json(body, { status })

async function loadSettings(admin: SupabaseClient): Promise<Record<string, string>> {
  const { data } = await admin.from('company_settings').select('key, value').like('key', 'whatsapp_listener_%')
  return Object.fromEntries((data || []).map((r: { key: string; value: string | null }) => [r.key, r.value ?? '']))
}

function buildDeps(admin: SupabaseClient, settings: Record<string, string>): ListenerDeps {
  const month = new Date().toISOString().slice(0, 7)
  return {
    enabled: listenerEnabled(settings),
    groups: parseGroupList(settings[LISTENER_KEYS.groups]),

    isStaffPhone: async last10 => {
      const { data } = await admin.from('employees').select('phone').eq('is_active', true)
      return (data || []).some((e: { phone: string | null }) => normalizePhone(e.phone) === last10)
    },

    isDuplicate: async messageId => {
      const { data } = await admin.from('request_activity').select('id')
        .eq('action', ACTION).eq('detail->>messageId', messageId).limit(1)
      return !!data?.length
    },

    recentRequest: async (chatId, senderId): Promise<RecentRequest | null> => {
      const since = new Date(Date.now() - BURST_MINUTES * 60_000).toISOString()
      const { data: act } = await admin.from('request_activity').select('request_id')
        .eq('action', ACTION).eq('detail->>chatId', chatId).eq('detail->>senderId', senderId)
        .gte('created_at', since).order('created_at', { ascending: false }).limit(1)
      const requestId = act?.[0]?.request_id as string | undefined
      if (!requestId) return null
      // Only while nobody has picked it up: once staff act on it, a new message starts a new request.
      const { data: req } = await admin.from('task_requests')
        .select('id, ref_no, description, extra_links, status, archived_at')
        .eq('id', requestId).maybeSingle()
      if (!req || req.status !== 'submitted' || req.archived_at) return null
      return {
        id: req.id as string,
        ref: `REQ-${String(req.ref_no ?? 0).padStart(4, '0')}`,
        description: (req.description as string | null) ?? null,
        extraLinks: Array.isArray(req.extra_links) ? (req.extra_links as { label: string; url: string }[]) : [],
      }
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

    transcribe: (audio, fileName) => transcribeAudio(audio, fileName),
    readImage: (file: SharedFile) => readImageText(file.bytes, file.type),
    store: async (file: SharedFile, kind: PartKind) => {
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

    append: async (requestId, change) => {
      const now = new Date().toISOString()
      const { error } = await admin.from('task_requests').update({
        description: change.description,
        extra_links: change.extraLinks,
        last_external_activity_at: now, // re-flags it as new for staff
        updated_at: now,
      }).eq('id', requestId)
      return !error
    },

    logMessage: async (requestId, m: ListenerMessage, summary) => {
      await admin.from('request_activity').insert({
        request_id: requestId,
        actor_type: 'client',
        actor_label: m.senderName || 'WhatsApp',
        action: ACTION,
        visibility: 'internal',
        detail: { message: summary, messageId: m.id, chatId: m.chatId, senderId: m.senderId, type: m.type },
      })
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
  if (!message || message.event !== 'message.received') {
    // Not a message (a test ping, a session event). It still proves the gateway is alive,
    // and a session event may say the number has stopped listening.
    const status = parseSessionStatus(payload)
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
      const outcome = await handleListenerMessage(message, buildDeps(admin, settings))
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
