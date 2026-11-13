/**
 * WhatsApp capture — turns something shared out of WhatsApp (a text message,
 * a voice note, a photo) into an item in the Requests inbox.
 *
 * Why this route: most client requests arrive in WhatsApp GROUPS, and WhatsApp
 * offers no official way to read group chats automatically. So a person
 * long-presses the message, taps Share, and picks the "Send to Cirqle"
 * shortcut; this module does the rest. See docs/WHATSAPP_CAPTURE.md.
 *
 * Rules it keeps:
 *  · Nothing is lost. If transcription or AI reading fails, the request is
 *    still filed, says so in its title, and carries the original file.
 *  · Nothing is acted on. It only files a request marked NEW for staff to
 *    read, correct and accept. It never creates a task or replies to anyone.
 *  · The original voice note / photo is kept in private storage and linked on
 *    the request, so staff can check what the AI heard.
 */

export type PartKind = 'audio' | 'image' | 'text' | 'unsupported'

/** Vercel rejects request bodies over 4.5 MB; stay under it with room for form overhead. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024
export const MAX_FILES = 5
export const MAX_TEXT_CHARS = 8000

const AUDIO_EXT = new Set(['opus', 'ogg', 'oga', 'm4a', 'mp3', 'mp4', 'aac', 'wav', 'webm', 'amr', 'mpga', 'flac', 'caf'])
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'])
const TEXT_EXT = new Set(['txt'])

function ext(name: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec((name || '').trim())
  return m ? m[1].toLowerCase() : ''
}

/** What a shared file is, from its type and name. The name wins when the type is generic. */
export function classifyPart(fileName: string, mime: string): PartKind {
  const type = (mime || '').toLowerCase()
  const e = ext(fileName)
  if (type.startsWith('audio/') || AUDIO_EXT.has(e)) {
    // .mp4 / .webm can be video; only treat as audio when the type says so or is unknown.
    if ((e === 'mp4' || e === 'webm') && type.startsWith('video/')) return 'unsupported'
    return 'audio'
  }
  if (type.startsWith('image/') || IMAGE_EXT.has(e)) return 'image'
  if (type.startsWith('text/') || TEXT_EXT.has(e)) return 'text'
  return 'unsupported'
}

/**
 * A file name the transcription service accepts.
 *
 * WhatsApp voice notes are Ogg/Opus but arrive named `PTT-….opus`, an
 * extension transcription services reject even though they accept the same
 * audio as `.ogg`. Unknown names fall back to `.ogg` too.
 */
export function transcriptionFileName(fileName: string): string {
  const e = ext(fileName)
  return e === 'opus' || e === 'oga' || !e ? 'voice-note.ogg' : `voice-note.${e}`
}

/**
 * Shared TEXT can arrive as a nameless file with no type (iOS Shortcuts turns a
 * shared message into a file when it is put in a file field). Treat a small,
 * nameless-or-.txt file as text when it decodes cleanly.
 */
export function looksLikeText(fileName: string, mime: string, bytes: ArrayBuffer): boolean {
  const e = ext(fileName)
  const type = (mime || '').toLowerCase()
  if (e && e !== 'txt') return false
  if (type && type !== 'application/octet-stream' && !type.startsWith('text/')) return false
  if (bytes.byteLength === 0 || bytes.byteLength > 100 * 1024) return false
  const view = new Uint8Array(bytes)
  if (view.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** A storage-safe file name that keeps the extension. */
export function safeStorageName(fileName: string, kind: PartKind): string {
  const e = ext(fileName) || (kind === 'audio' ? 'ogg' : kind === 'image' ? 'jpg' : 'bin')
  const base = (fileName || '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return `${base || kind}.${e}`
}

export interface CapturedPart {
  kind: PartKind
  /** Message text, a transcript, or what the AI read in a photo. */
  text: string | null
  /** True when a voice note or photo could not be turned into text. */
  unread: boolean
  /** Private link to the original voice note or photo. */
  link: string | null
}

const clean = (s: string | null | undefined) => (s || '').replace(/\r\n/g, '\n').trim()

/** Everything usable as text, in the order it was shared — what the AI parser reads. */
export function combinedText(message: string | null | undefined, parts: readonly CapturedPart[]): string {
  return [clean(message), ...parts.map(p => clean(p.text))].filter(Boolean).join('\n').slice(0, MAX_TEXT_CHARS)
}

/** The request's description: where it came from, then each piece labelled. */
export function buildDescription(input: {
  group?: string | null
  sender?: string | null
  message?: string | null
  parts: readonly CapturedPart[]
}): string {
  const from = ['From WhatsApp', clean(input.group), clean(input.sender) ? `sent by ${clean(input.sender)}` : ''].filter(Boolean).join(' · ')
  const lines: string[] = [from]
  if (clean(input.message)) lines.push('', clean(input.message))
  for (const p of input.parts) {
    if (p.kind === 'audio') {
      lines.push('', p.text ? `Voice note (transcribed by AI, check against the recording):\n${clean(p.text)}` : 'Voice note: could not be transcribed. Listen to the recording.')
    } else if (p.kind === 'image') {
      lines.push('', p.text ? `Photo (read by AI, check against the photo):\n${clean(p.text)}` : 'Photo attached.')
    } else if (p.kind === 'text' && p.text) {
      lines.push('', clean(p.text))
    }
  }
  return lines.join('\n').slice(0, MAX_TEXT_CHARS + 600)
}

/** A title when the AI gave none: the first words shared, or a plain statement of what arrived. */
export function fallbackTitle(text: string, parts: readonly CapturedPart[]): string {
  const first = clean(text).split('\n').find(l => l.trim())
  if (first) return first.length > 80 ? `${first.slice(0, 77)}…` : first
  if (parts.some(p => p.kind === 'audio')) return 'WhatsApp voice note — listen and add details'
  if (parts.some(p => p.kind === 'image')) return 'WhatsApp photo — open and add details'
  return 'WhatsApp message'
}

// ── The capture itself ──────────────────────────────────────────────────────

export interface SharedFile {
  name: string
  type: string
  bytes: ArrayBuffer
}

export interface CaptureInput {
  message?: string | null
  /** Client name typed or picked in the shortcut; overrides the AI's guess. */
  client?: string | null
  group?: string | null
  sender?: string | null
  files: SharedFile[]
}

export interface CaptureDeps {
  transcribe: (audio: ArrayBuffer, fileName: string) => Promise<string | null>
  /** Reads text out of a photo, or null when image reading is not set up. */
  readImage: (file: SharedFile) => Promise<string | null>
  /** Stores the original and returns a private link, or null if storage failed. */
  store: (file: SharedFile, kind: PartKind) => Promise<string | null>
  parse: (text: string) => Promise<{ client?: string; title?: string; service?: string; dueDate?: string }>
  file: (request: {
    title: string; client?: string; service?: string; dueDate?: string; notes: string
    extraLinks: { label: string; url: string }[]
  }) => Promise<{ ok: boolean; error?: string; ref?: string; title?: string; client?: string | null; matchedClient?: boolean }>
}

export type CaptureResult =
  | { ok: true; ref: string; title: string; client: string | null; matchedClient: boolean; heard: string | null; needsListening: boolean; skipped: string[] }
  | { ok: false; error: string }

/** Turns shared files into labelled parts: keeps each original, then transcribes or reads it. */
export async function collectParts(
  files: readonly SharedFile[],
  deps: Pick<CaptureDeps, 'transcribe' | 'readImage' | 'store'>,
): Promise<{ parts: CapturedPart[]; skipped: string[] }> {
  const parts: CapturedPart[] = []
  const skipped: string[] = []
  for (const f of files.slice(0, MAX_FILES)) {
    let kind = classifyPart(f.name, f.type)
    if (kind === 'unsupported' && looksLikeText(f.name, f.type, f.bytes)) kind = 'text'
    if (kind === 'unsupported') { skipped.push(`${f.name || 'file'} (this kind of file is not supported)`); continue }
    if (f.bytes.byteLength > MAX_FILE_BYTES) { skipped.push(`${f.name || 'file'} (over 4 MB)`); continue }
    if (f.bytes.byteLength === 0) { skipped.push(`${f.name || 'file'} (empty)`); continue }

    if (kind === 'text') {
      parts.push({ kind, text: new TextDecoder().decode(f.bytes).slice(0, MAX_TEXT_CHARS), unread: false, link: null })
      continue
    }
    // Keep the original first, so a failed AI step can never lose it.
    const link = await deps.store(f, kind).catch(() => null)
    const text = kind === 'audio'
      ? await deps.transcribe(f.bytes, transcriptionFileName(f.name)).catch(() => null)
      : await deps.readImage(f).catch(() => null)
    parts.push({ kind, text: clean(text) || null, unread: kind === 'audio' && !clean(text), link })
  }
  return { parts, skipped }
}

/** Link labels for the originals kept with a request. */
export function partLinks(parts: readonly CapturedPart[], startAt = 1): { label: string; url: string }[] {
  return parts
    .filter(p => p.link)
    .map((p, i) => ({ label: p.kind === 'audio' ? `WhatsApp voice note ${startAt + i}` : `WhatsApp photo ${startAt + i}`, url: p.link as string }))
}

export async function captureFromWhatsApp(input: CaptureInput, deps: CaptureDeps): Promise<CaptureResult> {
  const message = clean(input.message).slice(0, MAX_TEXT_CHARS)
  if (!message && input.files.length === 0) return { ok: false, error: 'Nothing was shared. Send a message, voice note or photo.' }

  const { parts, skipped } = await collectParts(input.files, deps)
  if (!message && parts.length === 0) {
    return { ok: false, error: `Could not use what was shared: ${skipped.join('; ')}.` }
  }

  const text = combinedText(message, parts)
  // The AI only suggests a title, client, service and date. A failure here must not stop the filing.
  const parsed = text ? await deps.parse(text).catch(() => ({} as Awaited<ReturnType<CaptureDeps['parse']>>)) : {}
  const needsListening = parts.some(p => p.unread)

  const filed = await deps.file({
    title: clean(parsed.title) || fallbackTitle(text, parts),
    client: clean(input.client) || parsed.client,
    service: parsed.service,
    dueDate: parsed.dueDate,
    notes: buildDescription({ group: input.group, sender: input.sender, message, parts }),
    extraLinks: partLinks(parts),
  })
  if (!filed.ok) return { ok: false, error: filed.error || 'Could not file the request.' }

  const transcript = parts.find(p => p.kind === 'audio' && p.text)?.text ?? null
  return {
    ok: true,
    ref: filed.ref || '',
    title: filed.title || '',
    client: filed.client ?? null,
    matchedClient: !!filed.matchedClient,
    heard: transcript ? (transcript.length > 200 ? `${transcript.slice(0, 197)}…` : transcript) : null,
    needsListening,
    skipped,
  }
}
