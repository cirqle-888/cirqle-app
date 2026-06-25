/**
 * Capture Engine — client auto-detection.
 *
 * Cross-cutting: the engine detects the client ONCE and shares it with every
 * adapter. Detection prefers the strongest signal first: phone (e.g. the
 * WhatsApp chat number in metadata) → email → name (explicit sender name, else
 * the classifier's client hint).
 *
 * `extractContacts` is pure (unit-tested); `detectClient` takes its lookups by
 * injection (defaulting to the real DB finders) so it can be tested without a
 * database.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { findClient, findClientByEmail, findClientByPhone } from '@/lib/ai/request-capture'
import type { CaptureClassification, CaptureInput, DetectedClient } from './types'

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i
// A loose phone candidate: optional +, then 9+ digits possibly split by spaces/()-.
const PHONE_RE = /\+?\d[\d\s().-]{8,}\d/g

export interface ExtractedContacts {
  phone: string | null
  email: string | null
  name: string | null
}

function firstPhone(text: string): string | null {
  const matches = text.match(PHONE_RE)
  if (!matches) return null
  for (const m of matches) {
    if (m.replace(/\D/g, '').length >= 10) return m.trim()
  }
  return null
}

/** Pull phone/email/name out of metadata first, then the raw text. Pure. */
export function extractContacts(text: string, metadata?: CaptureInput['metadata']): ExtractedContacts {
  const email = metadata?.email || text.match(EMAIL_RE)?.[0] || null
  const phone = metadata?.phone || firstPhone(text)
  const name = metadata?.senderName || null
  return {
    phone: phone ? phone.trim() : null,
    email: email ? email.toLowerCase() : null,
    name: name ? name.trim() : null,
  }
}

type ClientRow = { id: string; name: string } | null | undefined
export interface ClientLookups {
  byPhone: (admin: SupabaseClient, phone?: string | null) => Promise<ClientRow>
  byEmail: (admin: SupabaseClient, email?: string | null) => Promise<ClientRow>
  byName:  (admin: SupabaseClient, name?: string | null)  => Promise<ClientRow>
}

const DEFAULT_LOOKUPS: ClientLookups = {
  byPhone: findClientByPhone,
  byEmail: findClientByEmail,
  byName:  findClient,
}

/** Detect the client behind a capture. Phone > email > name. */
export async function detectClient(
  admin: SupabaseClient,
  input: CaptureInput,
  classification?: CaptureClassification,
  lookups: ClientLookups = DEFAULT_LOOKUPS,
): Promise<DetectedClient | null> {
  const c = extractContacts(input.payload, input.metadata)

  if (c.phone) {
    const hit = await lookups.byPhone(admin, c.phone)
    if (hit) return { id: hit.id, name: hit.name, matchedBy: 'phone' }
  }
  if (c.email) {
    const hit = await lookups.byEmail(admin, c.email)
    if (hit) return { id: hit.id, name: hit.name, matchedBy: 'email' }
  }
  const nameGuess = c.name || (classification?.hints?.client as string | undefined) || null
  if (nameGuess) {
    const hit = await lookups.byName(admin, nameGuess)
    if (hit) return { id: hit.id, name: hit.name, matchedBy: 'name' }
  }
  return null
}
