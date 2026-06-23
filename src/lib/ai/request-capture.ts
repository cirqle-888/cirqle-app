/**
 * Shared AI request-capture helpers — extracted out of /api/shortcut/route.ts
 * so the dashboard's "AI Capture" feature (Requests page) and the iOS
 * Shortcuts API use the exact same parsing + fuzzy-match logic instead of
 * two copies drifting apart.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const today = () => new Date().toISOString().split('T')[0]

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
  if (s === 'tomorrow') { const t = new Date(); t.setDate(t.getDate() + 1); return t.toISOString().split('T')[0] }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  return null
}

/**
 * AI-parse free text (a dictated note, a pasted WhatsApp message, an email
 * body) into structured work-request fields.
 * Uses Google Gemini (free tier — set GEMINI_API_KEY from Google AI Studio).
 * Model is overridable via GEMINI_MODEL; defaults to a free-tier Flash model.
 */
export async function aiParse(text: string): Promise<{ client?: string; title?: string; service?: string; dueDate?: string }> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('AI parsing is not configured (set GEMINI_API_KEY).')
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash'
  const todayStr = today()
  const body = JSON.stringify({
    system_instruction: {
      parts: [{ text:
        `You convert a short note (dictated, WhatsApp message, or email) into a design-agency work request. Today is ${todayStr}. ` +
        `Extract: client (the customer/business name), title (a short task title), service (the kind of work, ` +
        `e.g. "Menu Design", "Offer Flyer"), dueDate (resolve "tomorrow"/"next friday" etc. against today as ` +
        `yyyy-mm-dd, else null).` }],
    },
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 300,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          client:  { type: 'string' },
          title:   { type: 'string' },
          service: { type: 'string' },
          dueDate: { type: 'string', nullable: true },
        },
      },
    },
  })
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  // Free-tier per-minute limits can throw a transient 429; retry a couple times.
  let res!: Response
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body,
    })
    if (res.ok || res.status !== 429) break
    if (attempt < 2) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
  }
  if (!res.ok) {
    // Surface Gemini's real reason (quota exceeded, model not found, key invalid…)
    const detail = await res.text().catch(() => '')
    let msg = ''
    try { msg = JSON.parse(detail)?.error?.message || '' } catch { /* not json */ }
    throw new Error(`AI request failed (${res.status})${msg ? `: ${msg}` : ''}.`)
  }
  const data = await res.json()
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
  const match = raw.match(/\{[\s\S]*\}/)
  try { return JSON.parse(match ? match[0] : raw) } catch { return {} }
}
