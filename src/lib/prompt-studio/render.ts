/**
 * Prompt Studio — turns a template + field values + client card into the
 * final paste-ready text. Pure functions, no I/O, safe on server and client.
 */
import type { ClientCard, PromptTemplate } from './types'
import { CLIENT_CARD_FIELDS } from './client-card'

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

/** Every {{key}} used in a body, in first-seen order. Used for custom templates. */
export function placeholdersIn(body: string): string[] {
  const seen: string[] = []
  for (const m of body.matchAll(PLACEHOLDER)) if (!seen.includes(m[1])) seen.push(m[1])
  return seen
}

/** Required fields still empty — the UI disables Copy until this is []. */
export function missingRequired(t: PromptTemplate, values: Record<string, string>): string[] {
  return t.fields.filter(f => f.required && !(values[f.key] ?? '').trim()).map(f => f.label)
}

/** The client card as a compact block. Empty lines are left out. */
export function renderClientCard(card: ClientCard | null | undefined): string {
  if (!card) return ''
  const lines = CLIENT_CARD_FIELDS
    .map(f => [f.label, (card[f.key] ?? '').trim()] as const)
    .filter(([, v]) => v)
    .map(([label, v]) => `${label}: ${v.replace(/\s*\n\s*/g, '; ')}`)
  return lines.length ? `CLIENT CARD\n${lines.join('\n')}` : ''
}

/**
 * Fill the body. A line whose placeholders are all empty is removed, unless one
 * of them is required (then it stays visibly blank so the gap is obvious).
 */
export function renderBody(t: PromptTemplate, values: Record<string, string>): string {
  const required = new Set(t.fields.filter(f => f.required).map(f => f.key))
  const out: string[] = []
  for (const line of t.body.split('\n')) {
    const keys = [...line.matchAll(PLACEHOLDER)].map(m => m[1])
    if (keys.length) {
      const allEmpty = keys.every(k => !(values[k] ?? '').trim())
      if (allEmpty && !keys.some(k => required.has(k))) continue
    }
    out.push(line.replace(PLACEHOLDER, (_, k: string) => (values[k] ?? '').trim()))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Card (if the template uses it) + filled body. This is what gets copied. */
export function renderPrompt(
  t: PromptTemplate,
  values: Record<string, string>,
  card?: ClientCard | null,
): string {
  const head = t.usesClientCard ? renderClientCard(card) : ''
  const body = renderBody(t, values)
  return head ? `${head}\n\n${body}` : body
}

/** Rough token estimate (≈4 characters per token for English; Malayalam costs more). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
