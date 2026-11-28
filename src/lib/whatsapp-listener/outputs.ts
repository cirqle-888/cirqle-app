/**
 * Final outputs into the client's chat channel (pure).
 *
 * When Cirqle sends a photo — a finished design — into a client's WhatsApp
 * group, the listener already keeps it (./chat-log). This decides whether that
 * photo is also posted into the client's channel in Cirqle Chat, so the team
 * finds every delivery in one place, and words the message.
 *
 * Only photos Cirqle sent, only in a chat listed for a client, and only while
 * the switch is on. Nothing here sends anything to WhatsApp.
 */

import { LISTENER_KEYS } from './rules'

/** On unless switched off in Settings → WhatsApp Listener. */
export function outputsToChatOn(settings: Record<string, string | undefined>): boolean {
  return (settings[LISTENER_KEYS.outputsToChat] ?? '').trim().toLowerCase() !== 'off'
}

export interface OutputCandidate {
  /** Sent from the listener number or a Cirqle number. */
  fromCirqle: boolean
  /** The gateway's message type. */
  type: string
  /** Where the listener kept the photo; null when it could not keep it. */
  mediaPath: string | null
  /** The client this chat is listed for; empty for an internal chat. */
  clientName: string
}

/** Is this a photo Cirqle delivered to a client? */
export function isClientOutput(c: OutputCandidate): boolean {
  return c.fromCirqle && c.type === 'image' && !!c.mediaPath && c.clientName.trim().length > 0
}

/** The chat message that carries the photo. */
export function outputCaption(caption: string, byCqid: string | null): string {
  const head = `Sent to the client on WhatsApp${byCqid ? ` by ${byCqid}` : ''}`
  const text = caption.trim()
  return text ? `${head}\n${text}` : head
}

/** A readable file name for the attachment, from the kept path. */
export function outputFileName(mediaPath: string, sentAtIso: string): string {
  const last = mediaPath.split('/').pop() ?? ''
  // Kept as `<uuid>-<name>.<ext>`: drop the uuid.
  const name = last.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, '')
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? 'jpg'
  return !name || /^image\.[a-z0-9]+$/i.test(name) ? `whatsapp-${sentAtIso.slice(0, 10)}.${ext}` : name
}

/** Escape a client name for an exact, case-insensitive `ilike` match. */
export function exactIlike(name: string): string {
  return name.trim().replace(/[\\%_]/g, m => `\\${m}`)
}
