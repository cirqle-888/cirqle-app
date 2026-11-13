import { randomUUID, timingSafeEqual } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { createRequest } from '@/lib/shortcut/actions'
import { aiParse } from '@/lib/ai/request-capture'
import { transcribeAudio } from '@/lib/ai/transcribe'
import { readImageText } from '@/lib/ai/vision'
import { notifyAdmins } from '@/lib/notifications/create'
import {
  captureFromWhatsApp, safeStorageName, MAX_FILES, type PartKind, type SharedFile,
} from '@/lib/shortcut/whatsapp-capture'

/**
 * WhatsApp → Requests inbox, for the iPhone "Send to Cirqle" share shortcut.
 *
 *   POST /api/shortcut/whatsapp        (multipart/form-data)
 *   Authorization: Bearer <SHORTCUT_API_TOKEN>
 *
 *   file     one or more shared items: a voice note, a photo, or text (repeat the field for several)
 *   text     the message text, when text was shared                    (optional)
 *   client   client name, if the person sharing knows it               (optional, overrides the AI)
 *   group    WhatsApp group name                                       (optional)
 *   sender   who sent it                                               (optional)
 *
 * Files a request marked NEW for staff. It never creates a task, never
 * replies to anyone and never posts anywhere. Setup: docs/WHATSAPP_CAPTURE.md.
 *
 * Auth: a bearer token, no Supabase session (service-role client, so the token
 * IS the gate). Two tokens are accepted:
 *   WHATSAPP_CAPTURE_TOKEN  capture-only. Give THIS one to staff phones: it
 *                           can file a request here and do nothing else.
 *   SHORTCUT_API_TOKEN      the owner's quick-action token. It also works on
 *                           /api/shortcut, where it can record payments and
 *                           expenses, so do not hand it to staff.
 */

// Transcription plus AI parsing of a long voice note can take a while.
export const maxDuration = 60

const BUCKET = 'chat-attachments'
const LINK_SECONDS = 365 * 24 * 60 * 60

const json = (body: unknown, status = 200) => NextResponse.json(body, { status })

function acceptedTokens(): string[] {
  return [process.env.WHATSAPP_CAPTURE_TOKEN, process.env.SHORTCUT_API_TOKEN]
    .map(t => (t || '').trim())
    .filter(t => t.length >= 16)
}

function authorized(req: NextRequest): boolean {
  const got = Buffer.from((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim())
  if (got.length === 0) return false
  return acceptedTokens().some(t => {
    const want = Buffer.from(t)
    return want.length === got.length && timingSafeEqual(want, got)
  })
}

const field = (form: FormData, name: string): string | null => {
  const v = form.get(name)
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 8000) : null
}

export async function POST(req: NextRequest) {
  if (acceptedTokens().length === 0) {
    return json({ ok: false, error: 'WhatsApp capture is disabled (set WHATSAPP_CAPTURE_TOKEN or SHORTCUT_API_TOKEN).' }, 503)
  }
  if (!authorized(req)) return json({ ok: false, error: 'Unauthorized.' }, 401)

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return json({ ok: false, error: 'Send this as a form (multipart/form-data) with a "file" or "text" field.' }, 400)
  }

  const files: SharedFile[] = []
  for (const entry of form.getAll('file')) {
    if (files.length >= MAX_FILES) break
    if (typeof entry === 'string') continue
    files.push({ name: entry.name || '', type: entry.type || '', bytes: await entry.arrayBuffer() })
  }

  const admin = createAdminClient()
  const month = new Date().toISOString().slice(0, 7)

  try {
    const result = await captureFromWhatsApp(
      { message: field(form, 'text'), client: field(form, 'client'), group: field(form, 'group'), sender: field(form, 'sender'), files },
      {
        transcribe: (audio, fileName) => transcribeAudio(audio, fileName),
        readImage: file => readImageText(file.bytes, file.type),
        store: async (file: SharedFile, kind: PartKind) => {
          const path = `whatsapp-capture/${month}/${randomUUID()}-${safeStorageName(file.name, kind)}`
          const { error } = await admin.storage.from(BUCKET).upload(path, file.bytes, {
            contentType: file.type || (kind === 'audio' ? 'audio/ogg' : 'image/jpeg'),
            upsert: false,
          })
          if (error) { console.warn('[whatsapp-capture] could not store the original:', error.message); return null }
          const { data } = await admin.storage.from(BUCKET).createSignedUrl(path, LINK_SECONDS)
          return data?.signedUrl ?? null
        },
        parse: text => aiParse(text),
        file: r => createRequest(admin, { ...r, unviewed: true }),
      },
    )
    if (!result.ok) return json(result, 400)

    await notifyAdmins({
      type: 'whatsapp_request',
      title: `New WhatsApp request — ${result.client || 'client not matched'}`,
      message: `${result.ref}: ${result.title}${result.needsListening ? ' (voice note needs listening)' : ''}`,
      link: '/dashboard/requests',
      sourceKey: `whatsapp_request:${result.ref}`,
    })

    // `say` is one line a Shortcut can show or speak as its confirmation.
    const say = [
      `Filed ${result.ref}: ${result.title}`,
      result.client ? (result.matchedClient ? `Client: ${result.client}` : `Client "${result.client}" not found in Cirqle`) : 'No client matched',
      result.needsListening ? 'The voice note could not be transcribed' : '',
      result.skipped.length ? `Skipped: ${result.skipped.join('; ')}` : '',
    ].filter(Boolean).join('. ')
    return json({ ...result, say })
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : 'Server error.' }, 500)
  }
}
