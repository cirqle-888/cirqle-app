/**
 * Prompt Studio — turns a template + field values + client card into the
 * final paste-ready text. Pure functions, no I/O, safe on server and client.
 */
import { TOGGLE_ON, type ClientCard, type PromptTemplate } from './types'
import { CLIENT_CARD_FIELDS } from './client-card'
import { styleBlock } from './style'

/**
 * {{key}} or {{key|default words}}: with a default, an empty field prints the
 * default instead (so a template still reads well with nothing filled in), and
 * its line is never dropped.
 */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|([^{}]*))?\}\}/g

/** Every {{key}} used in a body, in first-seen order. Used for custom templates. */
export function placeholdersIn(body: string): string[] {
  const seen: string[] = []
  for (const m of body.matchAll(PLACEHOLDER)) if (!seen.includes(m[1])) seen.push(m[1])
  return seen
}

/**
 * The values a template actually uses: its defaults under what the user typed
 * (typed wins, even when cleared on purpose to ""), with every field behind an
 * unticked toggle counted as empty. Typed values behind a toggle are kept in
 * the form, so ticking it again brings them back.
 */
export function withDefaults(t: PromptTemplate, values: Record<string, string>): Record<string, string> {
  const v = { ...(t.defaults || {}), ...values }
  const toggles = new Set(t.fields.filter(f => f.type === 'toggle').map(f => f.key))
  for (const f of t.fields)
    if (f.showIf && toggles.has(f.showIf) && v[f.showIf] !== TOGGLE_ON) v[f.key] = ''
  return v
}

/** Whether a field is on screen: a field behind a toggle shows only while it is ticked. */
export function isShown(t: PromptTemplate, key: string, values: Record<string, string>): boolean {
  const f = t.fields.find(x => x.key === key)
  if (!f?.showIf || !t.fields.some(x => x.key === f.showIf && x.type === 'toggle')) return true
  return withDefaults(t, values)[f.showIf] === TOGGLE_ON
}

/** Required fields still empty — the UI disables Copy until this is []. */
export function missingRequired(t: PromptTemplate, values: Record<string, string>): string[] {
  const v = withDefaults(t, values)
  return t.fields.filter(f => f.required && !(v[f.key] ?? '').trim()).map(f => f.label)
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
export function renderBody(t: PromptTemplate, input: Record<string, string>): string {
  const values = withDefaults(t, input)
  const required = new Set(t.fields.filter(f => f.required).map(f => f.key))
  const out: string[] = []
  for (const line of t.body.split('\n')) {
    const found = [...line.matchAll(PLACEHOLDER)]
    if (found.length) {
      const allEmpty = found.every(m => !(values[m[1]] ?? '').trim() && m[2] === undefined)
      if (allEmpty && !found.some(m => required.has(m[1]))) continue
    }
    out.push(line.replace(PLACEHOLDER, (_, k: string, fallback?: string) => (values[k] ?? '').trim() || (fallback ?? '').trim()))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** "Use the CLIENT CARD above." and its variants, for when there is no card to point at. */
const CARD_POINTER = /[ \t]*Use the CLIENT CARD above\.?/g

/**
 * Card (if the template uses it) + filled body. This is what gets copied.
 * `language` overrides the card's language for this one prompt (and works
 * without a card); `style` mixes in a saved style recipe. With no card at all, the body's pointer to it is removed so
 * the AI isn't told to use something that isn't there.
 */
export function renderPrompt(
  t: PromptTemplate,
  values: Record<string, string>,
  card?: ClientCard | null,
  opts?: { language?: string; style?: string },
): string {
  const merged = opts?.language ? { ...(card || {}), language: opts.language } : card
  const head = t.usesClientCard ? renderClientCard(merged) : ''
  let body = renderBody(t, values)
  if (!head) body = body.replace(CARD_POINTER, '').replace(/^[ \t]+$/gm, '')
  // A saved style mixed in from the picker sits between the card and the task.
  const parts = [head, opts?.style?.trim() ? styleBlock(opts.style) : '', body].filter(Boolean)
  return parts.join('\n\n')
}

/**
 * Rough token estimate: about 4 characters per token for English. Malayalam,
 * Arabic and other non-Latin scripts cost far more (roughly a token for every
 * 1–2 characters), so they are counted separately.
 */
export function estimateTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 4 + other / 1.5)
}
