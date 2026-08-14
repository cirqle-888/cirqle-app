/**
 * Shared AI request-capture helpers — extracted out of /api/shortcut/route.ts
 * so the dashboard's "AI Capture" feature (Requests page) and the iOS
 * Shortcuts API use the exact same parsing + fuzzy-match logic instead of
 * two copies drifting apart.
 *
 * AI parsing runs on Groq (free tier, no billing required) via the shared
 * caller in src/lib/ai/groq.ts — see aiParse() below.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callGroqJSON } from './groq'
import { toISODate, todayISO } from '@/lib/utils/local-date'

const today = () => todayISO()

/** Find a client by (fuzzy) name — exact match wins, else shortest contains-match. */
export async function findClient(admin: SupabaseClient, name?: string | null) {
  const q = (name || '').trim()
  if (!q) return null
  const { data } = await admin
    .from('clients')
    .select('id, name, code')
    .ilike('name', `%${q}%`)
    .limit(10)
  const rows = data || []
  if (rows.length === 0) return null
  const exact = rows.find((r: any) => r.name.toLowerCase() === q.toLowerCase())
  return exact || rows.sort((a: any, b: any) => a.name.length - b.name.length)[0]
}

/** Reduce a free-form phone string to its comparable local digits (last 10 for India). */
export function normalizePhone(raw?: string | null): string {
  const d = (raw || '').replace(/\D/g, '')
  return d.length > 10 ? d.slice(-10) : d
}

/**
 * Find a client by phone number. `clients.phone` is free-form text, so we
 * normalize both sides to the last-10 digits and compare in JS (the client
 * list is small for an agency). Returns null on no/short match.
 */
export async function findClientByPhone(admin: SupabaseClient, phone?: string | null) {
  const target = normalizePhone(phone)
  if (target.length < 10) return null
  const { data } = await admin
    .from('clients').select('id, name, phone').not('phone', 'is', null).limit(5000)
  for (const c of data || []) {
    if (normalizePhone((c as any).phone) === target) {
      return { id: (c as any).id as string, name: (c as any).name as string }
    }
  }
  return null
}

/** Find a client by exact (case-insensitive) email. */
export async function findClientByEmail(admin: SupabaseClient, email?: string | null) {
  const e = (email || '').trim().toLowerCase()
  if (!e || !e.includes('@')) return null
  const { data } = await admin
    .from('clients').select('id, name').ilike('email', e).limit(1).maybeSingle()
  return data ? { id: (data as any).id as string, name: (data as any).name as string } : null
}

/** Find a service by (fuzzy) name. */
export async function findService(admin: SupabaseClient, name?: string | null) {
  const q = (name || '').trim()
  if (!q) return null
  const { data } = await admin
    .from('services').select('id, name').eq('is_active', true).ilike('name', `%${q}%`).limit(10)
  const rows = data || []
  if (!rows.length) return null
  const exact = rows.find((r: any) => r.name.toLowerCase() === q.toLowerCase())
  return exact || rows.sort((a: any, b: any) => a.name.length - b.name.length)[0]
}

/** Resolve a relative date phrase the caller couldn't ("tomorrow" handled in the AI step itself). */
export function normalizeDate(d?: string | null): string | null {
  if (!d) return null
  const s = d.trim().toLowerCase()
  if (s === 'today') return today()
  if (s === 'tomorrow') { const t = new Date(); t.setDate(t.getDate() + 1); return toISODate(t) }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  return null
}

/**
 * AI-parse free text (a dictated note, a pasted WhatsApp message, an email
 * body) into structured work-request fields.
 */
export async function aiParse(text: string): Promise<{ client?: string; title?: string; service?: string; dueDate?: string }> {
  const todayStr = today()
  return callGroqJSON(
    `You convert a short note (dictated, WhatsApp message, or email) into a design-agency work request. Today is ${todayStr}. ` +
    `Extract: client (the customer/business name), title (a short task title), service (the kind of work, ` +
    `e.g. "Menu Design", "Offer Flyer"), dueDate (resolve "tomorrow"/"next friday" etc. against today as ` +
    `yyyy-mm-dd, else null). Do not think out loud, do not explain, do not use <think> tags. ` +
    `Respond with ONLY a JSON object with keys client, title, service, dueDate — no other text whatsoever.`,
    text,
  )
}
