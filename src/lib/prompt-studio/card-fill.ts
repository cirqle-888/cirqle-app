/**
 * Prompt Studio — filling a Client Card with an outside AI.
 *
 * The planner copies a master prompt (the client's name and page links), pastes
 * it into an AI that can browse (Claude, ChatGPT, Gemini), and pastes the
 * answer back. The answer is a list of "Label: value" lines, read here into
 * the card's fields. Nothing is saved until a person has looked it over.
 * Pure: no I/O.
 */
import { CLIENT_CARD_FIELDS } from './client-card'
import { MULTI_SEP, type ClientCard, type PromptField } from './types'

/** What the AI should write for each field. Fields not listed here are for people to fill (logo, tools). */
const HINTS: Record<string, string> = {
  brand: 'the name exactly as the page writes it',
  business: 'what they sell or do, in one line',
  location: 'area, town, district, state',
  offer: 'a current package or offer with its price, only if a post shows it',
  contact: 'phone numbers in the order the page shows them, then the address',
  audience: 'who their posts speak to',
  language: 'the language of their posts',
  look: 'the look and feel in one line',
  colors: 'main colours with hex codes, read from the logo and recent posts',
  colorUse: 'the one that matches how their feed uses colour',
  feedStyle: 'the one that matches their last 12 posts',
  history: '4 to 6 sentences: layout patterns, fonts and headline style, photo or video style, caption tone, emoji and hashtag habits, series they repeat, what to keep and what to stop',
  mustShow: 'things nearly every post shows',
  neverShow: 'only if the page makes it clear',
  platforms: 'only platforms you found a live page for',
  postsPerWeek: 'what they post now, counted from the last 4 weeks, like "3 posters + 2 reels"',
  goal: 'the action their posts ask for most',
  gulf: 'only if posts speak to people in the Gulf',
  worked: 'their 3 posts with the most likes or views, and what those have in common',
  competitors: 'similar pages in the same area, as @handles',
  links: 'every official page you confirmed',
}

/** The fields the style study is about: how the page looks and sounds, not who the client is. */
const STYLE_KEYS = ['look', 'colors', 'colorUse', 'feedStyle', 'history', 'worked', 'postsPerWeek']

const fieldLine = (f: PromptField) => {
  const pick = f.type === 'select' ? ` Choose one, word for word: ${(f.options ?? []).join(' | ')}`
    : f.type === 'multi' ? ` Choose from: ${(f.options ?? []).join(', ')}`
    : ''
  return `${f.label}: <${HINTS[f.key]}.${pick}>`
}

const RULES = `Use only what you can see on those pages. If a detail is not there, leave the line empty after the colon: never guess and never invent a phone number, price or address. If you are not sure of a value, write it and add (check) at the end.

Reply with only the lines below, in one code block. Keep every label exactly as written, in English. Put each value on one line after its label, in place of the hint in < >.`

function known(card: ClientCard | null | undefined, keys: string[]): string {
  const lines = CLIENT_CARD_FIELDS
    .filter(f => keys.includes(f.key) && (card?.[f.key] ?? '').trim())
    .map(f => `${f.label}: ${(card![f.key] ?? '').trim().replace(/\s*\n\s*/g, '; ')}`)
  return lines.length ? `\nALREADY ON THE CARD (correct it only if the pages clearly say otherwise):\n${lines.join('\n')}\n` : ''
}

/**
 * The master prompt: research the client from their pages and return every
 * card field. `links` are the pages to open; without one the AI is told to
 * find the official page first.
 */
export function cardFillPrompt(o: { name: string; links?: string; card?: ClientCard | null }): string {
  const fields = CLIENT_CARD_FIELDS.filter(f => HINTS[f.key])
  const links = (o.links ?? '').trim()
  return `You are a senior brand strategist and designer setting up a new client for a social media agency. Fill in the Client Card for this business.

CLIENT: ${o.name.trim()}
PAGES: ${links || 'none given: search for their official Instagram, Facebook and website first, and list the ones you are sure of under "Page links"'}
${known(o.card, fields.map(f => f.key).filter(k => k !== 'links'))}
Open every page. On Instagram and Facebook read the bio, the highlights, and the last 15 posts with their captions. Open the website and the map listing if there is one.

${RULES}

${fields.map(fieldLine).join('\n')}`
}

/** A shorter prompt for a card that is already filled: only how the page looks, sounds and performs. */
export function styleStudyPrompt(o: { name: string; links?: string; card?: ClientCard | null }): string {
  const fields = CLIENT_CARD_FIELDS.filter(f => STYLE_KEYS.includes(f.key))
  const links = (o.links ?? '').trim()
  return `You are a senior designer and social media strategist. Study how this client's page looks and sounds today, so new posts can match it or improve on it.

CLIENT: ${o.name.trim()}
PAGES: ${links || 'none given: search for their official Instagram page first'}
${known(o.card, STYLE_KEYS)}
Open the pages and look at the last 20 posts and reels: layouts, colours, fonts, photos, captions, and which posts got the most likes or views.

${RULES}

${fields.map(fieldLine).join('\n')}`
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const LABELS = new Map<string, PromptField>(CLIENT_CARD_FIELDS.flatMap(f => [[norm(f.label), f], [norm(f.key), f]] as [string, PromptField][]))
const EMPTY = /^(-|–|—|n\/?a|none|nil|unknown|not found|not available|not shown|not sure|not clear|not mentioned|\(check\))\.?$/i
const LINE = /^\s*(?:[-*•]\s*)?(?:\*\*|__)?([A-Za-z][A-Za-z /'-]{1,45}?)(?:\*\*|__)?\s*[:：](?:\*\*|__)?\s*(.*)$/

/** One of the field's options, matched loosely ("Same family", "bookings."), or '' when it is none of them. */
function option(f: PromptField, raw: string): string {
  const v = norm(raw.replace(/\(check\)/gi, ''))
  if (!v) return ''
  const opts = f.options ?? []
  return opts.find(o => norm(o) === v)
    ?? opts.find(o => norm(o).startsWith(v) || v.startsWith(norm(o)))
    ?? opts.find(o => norm(o.split(':')[0]) === norm(raw.split(':')[0]))
    ?? ''
}

export interface CardAnswer {
  /** Field key → value, only for fields the answer filled. */
  card: Record<string, string>
  /** Labels of the fields that were filled, in card order. */
  filled: string[]
  /** Labels whose value was not one of the allowed choices, so it was left out. */
  refused: string[]
}

/**
 * Read the AI's answer into card fields. Lines that are not "Label: value"
 * for a known label continue the value above them. Empty values, leftover
 * hints and "not found" are skipped, so they never wipe what the card has.
 */
export function parseCardAnswer(text: string): CardAnswer {
  const raw = new Map<string, string>()
  let cur: PromptField | null = null
  // When the answer has a code block, the card is what is inside it; notes around it are not.
  const fenced = [...(text || '').matchAll(/```[a-z]*\r?\n([\s\S]*?)```/gi)].map(m => m[1])
  const body = fenced.some(b => LINE.test(b.split(/\r?\n/)[0] ?? '') || b.includes(':')) ? fenced.join('\n') : (text || '').replace(/```[a-z]*/gi, '')
  for (const line of body.split(/\r?\n/)) {
    const m = LINE.exec(line)
    const f = m ? LABELS.get(norm(m[1])) : undefined
    if (m && f) {
      cur = f
      raw.set(f.key, m[2].trim())
    } else if (cur && line.trim() && !/^\s*(#{1,6}\s|[-=_*]{3,}\s*$)/.test(line)) {
      raw.set(cur.key, `${raw.get(cur.key) ?? ''}${cur.type === 'textarea' ? '\n' : ' '}${line.trim()}`.trim())
    }
  }
  const card: Record<string, string> = {}
  const refused: string[] = []
  for (const f of CLIENT_CARD_FIELDS) {
    // A hint left in place ("<the name as the page writes it>") is not a value.
    let v = (raw.get(f.key) ?? '').replace(/\*\*|__|`/g, '').replace(/^<[^>]*>\s*/, '').trim()
    if (!v || EMPTY.test(v)) continue
    if (f.type === 'select') {
      v = option(f, v)
      if (!v) { refused.push(f.label); continue }
    } else if (f.type === 'multi') {
      const picked = (f.options ?? []).filter(o => v.split(/[,;/+|&]|\band\b/i).some(p => norm(p.replace(/\(.*?\)/g, '')) === norm(o)))
      if (!picked.length) { refused.push(f.label); continue }
      v = picked.join(MULTI_SEP)
    } else if (f.type !== 'textarea') {
      v = v.replace(/\s+/g, ' ')
    }
    card[f.key] = v.slice(0, 4000)
  }
  return { card, filled: CLIENT_CARD_FIELDS.filter(f => card[f.key]).map(f => f.label), refused }
}
