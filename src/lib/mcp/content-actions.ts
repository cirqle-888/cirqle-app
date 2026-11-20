/* eslint-disable @typescript-eslint/no-explicit-any -- rows from the untyped Supabase admin client; each is narrowed before it leaves this file. */
/**
 * Prompt Studio for the MCP server: the Client Card (read, fill), the prompt
 * templates (built-in and the team's own) and the prompt library. Everything
 * an AI needs to work in a client's voice and look without a person copying
 * text between the app and the chat.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { CLIENT_CARD_FIELDS } from '@/lib/prompt-studio/client-card'
import { parseCardAnswer } from '@/lib/prompt-studio/card-fill'
import { missingRequired, renderClientCard, renderPrompt } from '@/lib/prompt-studio/render'
import { TEMPLATES } from '@/lib/prompt-studio/templates'
import type { ClientCard, PromptTemplate } from '@/lib/prompt-studio/types'

type Admin = SupabaseClient<any, any, any>

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** A card field by its key ("feedStyle") or its label ("Feed style"). */
export function cardField(name: string) {
  const n = norm(name)
  return CLIENT_CARD_FIELDS.find(f => norm(f.key) === n || norm(f.label) === n)
}

/** What each field accepts, for the AI to read before it writes. */
export function cardSchema() {
  return CLIENT_CARD_FIELDS.map(f => ({
    key: f.key, label: f.label, type: f.type,
    ...(f.options ? { options: f.options } : {}),
    ...(f.help ? { help: f.help } : {}),
  }))
}

export interface CardPatchResult {
  card: ClientCard
  changed: string[]
  refused: { field: string; reason: string }[]
}

/**
 * Merge new values into a card, with the same checks as "Fill with AI":
 * choices must be one of the field's options (matched loosely), multi-choice
 * values are split and matched, and an unknown field is refused, not stored.
 * A field listed in `clear` is emptied; an empty value never wipes anything.
 */
export function mergeCard(current: ClientCard, values: Record<string, string>, clear: string[] = []): CardPatchResult {
  const card: ClientCard = { ...current }
  const changed: string[] = []
  const refused: { field: string; reason: string }[] = []
  const lines: string[] = []
  for (const [name, raw] of Object.entries(values)) {
    const f = cardField(name)
    if (!f) { refused.push({ field: name, reason: 'not a Client Card field' }); continue }
    const v = String(raw ?? '').trim()
    if (!v) continue
    // One "Label: value" line per field; the parser handles choices and multi-line text.
    lines.push(`${f.label}: ${f.type === 'textarea' ? v : v.replace(/\s*\n\s*/g, ' ')}`)
  }
  const parsed = parseCardAnswer(lines.join('\n'))
  for (const label of parsed.refused) refused.push({ field: label, reason: 'not one of the allowed choices' })
  for (const f of CLIENT_CARD_FIELDS) {
    const v = parsed.card[f.key]
    if (v === undefined) continue
    if ((card[f.key] ?? '') !== v) { card[f.key] = v; changed.push(f.label) }
  }
  for (const name of clear) {
    const f = cardField(name)
    if (!f) { refused.push({ field: name, reason: 'not a Client Card field' }); continue }
    if ((card[f.key] ?? '').trim()) { card[f.key] = ''; changed.push(`${f.label} (cleared)`) }
  }
  return { card, changed, refused }
}

export async function readCard(admin: Admin, clientId: string) {
  const { data, error } = await admin.from('prompt_client_cards').select('card, updated_at').eq('client_id', clientId).maybeSingle()
  if (error) return { ok: false as const, error: error.message }
  return { ok: true as const, card: ((data as any)?.card || {}) as ClientCard, updated_at: (data as any)?.updated_at ?? null }
}

export async function saveCard(admin: Admin, clientId: string, card: ClientCard) {
  const clean = Object.fromEntries(CLIENT_CARD_FIELDS.map(f => [f.key, card[f.key] || '']))
  const { error } = await admin.from('prompt_client_cards')
    .upsert({ client_id: clientId, card: clean, updated_at: new Date().toISOString() }, { onConflict: 'client_id' })
  return error ? { ok: false as const, error: error.message } : { ok: true as const }
}

/** The card as the AI sees it, plus what is still empty. */
export function describeCard(card: ClientCard) {
  const empty = CLIENT_CARD_FIELDS.filter(f => !(card[f.key] ?? '').trim()).map(f => f.label)
  return { text: renderClientCard(card), empty }
}

// ── Templates ───────────────────────────────────────────────────────────────

const CUSTOM_COLS = 'key, name, category, purpose, use_in, uses_client_card, fields, body'

/** A team template from the database in the built-in shape. */
export function customTemplate(row: any): PromptTemplate {
  return {
    key: String(row.key), name: String(row.name), category: row.category,
    purpose: row.purpose || '', useIn: row.use_in || '', usesClientCard: row.uses_client_card !== false,
    fields: Array.isArray(row.fields) ? row.fields : [], body: String(row.body || ''),
  }
}

export async function allTemplates(admin: Admin): Promise<(PromptTemplate & { custom?: boolean })[]> {
  let custom: PromptTemplate[] = []
  try {
    const { data } = await admin.from('prompt_templates').select(CUSTOM_COLS).is('deleted_at', null)
    custom = ((data || []) as any[]).map(customTemplate)
  } catch { /* table not there yet: built-ins only */ }
  return [...TEMPLATES, ...custom.map(t => ({ ...t, custom: true }))]
}

/** One line per template, for choosing. */
export function templateSummary(t: PromptTemplate & { custom?: boolean }) {
  return {
    key: t.key, name: t.name, category: t.category, purpose: t.purpose, use_in: t.useIn,
    uses_client_card: t.usesClientCard, needs_web_search: !!t.web, team_template: !!t.custom,
    fields: t.fields.map(f => ({
      key: f.key, label: f.label, type: f.type, required: !!f.required,
      ...(f.options ? { options: f.options } : {}), ...(f.placeholder ? { example: f.placeholder } : {}),
    })),
  }
}

/** Fill a template the same way the Create tab does; refuses when a required field is empty. */
export function buildPrompt(t: PromptTemplate, values: Record<string, string>, card: ClientCard | null, opts: { language?: string; colorUse?: string } = {}) {
  const v = { ...(t.defaults || {}), ...values }
  const missing = missingRequired(t, v)
  if (missing.length) return { ok: false as const, error: `Fill in: ${missing.join(', ')}.` }
  return { ok: true as const, prompt: renderPrompt(t, v, t.usesClientCard ? card : null, opts) }
}
