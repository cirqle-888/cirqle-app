/**
 * Shared AI request-capture helpers — extracted out of /api/shortcut/route.ts
 * so the dashboard's "AI Capture" feature (Requests page) and the iOS
 * Shortcuts API use the exact same parsing + fuzzy-match logic instead of
 * two copies drifting apart.
 *
 * AI parsing runs on Groq (free tier, no billing required) rather than a
 * paid/billing-gated provider — see aiParse() below.
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
 * Uses Groq (genuinely free tier, no billing/card required — set GROQ_API_KEY
 * from console.groq.com/keys). OpenAI-compatible chat-completions API.
 * Model is overridable via GROQ_MODEL; defaults to Qwen3 32B.
 */
export async function aiParse(text: string): Promise<{ client?: string; title?: string; service?: string; dueDate?: string }> {
  const key = process.env.GROQ_API_KEY
  if (!key) throw new Error('AI parsing is not configured (set GROQ_API_KEY).')
  const model = process.env.GROQ_MODEL || 'qwen/qwen3-32b'
  const todayStr = today()
  const body = JSON.stringify({
    model,
    temperature: 0,
    max_tokens: 300,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          `You convert a short note (dictated, WhatsApp message, or email) into a design-agency work request. Today is ${todayStr}. ` +
          `Extract: client (the customer/business name), title (a short task title), service (the kind of work, ` +
          `e.g. "Menu Design", "Offer Flyer"), dueDate (resolve "tomorrow"/"next friday" etc. against today as ` +
          `yyyy-mm-dd, else null). Respond with ONLY a JSON object with keys client, title, service, dueDate — no other text.`,
      },
      { role: 'user', content: text },
    ],
  })
  const url = 'https://api.groq.com/openai/v1/chat/completions'
  // Free-tier per-minute limits can throw a transient 429; retry a couple times.
  let res!: Response
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body,
    })
    if (res.ok || res.status !== 429) break
    if (attempt < 2) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
  }
  if (!res.ok) {
    // Surface Groq's real reason (quota exceeded, model not found, key invalid…)
    const detail = await res.text().catch(() => '')
    let msg = ''
    try { msg = JSON.parse(detail)?.error?.message || '' } catch { /* not json */ }
    throw new Error(`AI request failed (${res.status})${msg ? `: ${msg}` : ''}.`)
  }
  const data = await res.json()
  const raw = data?.choices?.[0]?.message?.content || '{}'
  const match = raw.match(/\{[\s\S]*\}/)
  try { return JSON.parse(match ? match[0] : raw) } catch { return {} }
}
