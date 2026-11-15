/**
 * WhatsApp listener — the flyer desk. Pure rules.
 *
 * Every offer price list a client sends becomes an "Untitled" flyer on its
 * social calendar (offer-plan.ts). This works out, from the same chat, how far
 * each of those flyers has got:
 *
 *   new       the list is in, Cirqle has not posted a design yet
 *   sent      Cirqle posted a design, the client has not answered
 *   changes   the client answered with something other than "ok"
 *   approved  the client answered "ok" / "super" / a thumbs-up
 *
 * Nothing is stored for this: it is read off the conversation each time, so it
 * can never disagree with the chat. It also checks a list's prices against the
 * same client's earlier lists before the list goes to Offer Studio.
 */

import { isAcknowledgement } from './rules'
import { isPriceLine, parseOfferNotes } from './offer-plan'

export type FlyerStage = 'new' | 'sent' | 'changes' | 'approved'

export interface DeskMessage {
  /** What a photo says, when it was read. */
  media_text?: string | null
  chat_id: string
  from_cirqle: boolean
  type: string
  body: string | null
  sent_at: string
}

export interface FlyerProgress {
  stage: FlyerStage
  /** Pictures and files Cirqle posted for this flyer. One page is often posted several times. */
  designs: number
  /** Different pages among them, told apart by what each one says. Null when none could be read. */
  pages: number | null
  /** Designs whose writing could not be read (a PDF, a very large file), so they are in no page count. */
  unreadDesigns: number
  /** Times the client came back with changes after a design. */
  corrections: number
  firstDesignAt: string | null
  approvedAt: string | null
  /** What the newest design says (read off the photo), for finding its offer title. */
  designText: string | null
}

/** Designs this close after an approval belong to the approved set. */
export const SAME_BURST_MINUTES = 3

const isDesign = (m: DeskMessage) => m.from_cirqle && (m.type === 'image' || m.type === 'document')

// ── Pages, not pictures ─────────────────────────────────────────────────────

/**
 * Two readings of one page share this much of their wording; two pages of one flyer
 * share far less. Measured on real flyers: the same page posted small, large and
 * corrected scored 0.74 to 0.97 against itself, and 0.35 to 0.41 against the other
 * page (the shop name, heading and dates are on both).
 */
export const SAME_PAGE = 0.58
/** Fewer words than this is a logo or a stray photo, not a flyer page. */
export const MIN_PAGE_WORDS = 8

const pageWords = (text: string) =>
  new Set(text.toLowerCase().replace(/[^a-z\u0d00-\u0d7f]+/g, ' ').split(' ').filter(w => w.length >= 3))

function alike(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let both = 0
  for (const w of a) if (b.has(w)) both++
  return both / (a.size + b.size - both || 1)
}

/**
 * How many different pages a set of posted designs is. A page goes up more than
 * once (a small and a large copy, then again after each correction), so counting
 * pictures overstates the flyer; pictures that say the same thing are one page.
 * `texts` is what each design says, null when it was not read.
 */
export function countPages(texts: readonly (string | null | undefined)[]): { pages: number | null; unread: number } {
  const pages: Set<string>[][] = []
  let unread = 0
  for (const t of texts) {
    const words = pageWords(String(t || ''))
    if (words.size < MIN_PAGE_WORDS) { unread++; continue }
    const same = pages.find(page => page.some(seen => alike(seen, words) >= SAME_PAGE))
    if (same) same.push(words)
    else pages.push([words])
  }
  return { pages: pages.length || null, unread }
}

// "Ok" after a design is the approval. Greetings are acknowledgements too, but approve nothing.
const NOT_APPROVAL = /^(hi|hello|hey|good morning|good night|gm|gn|no|welcome)$/i
export function isApproval(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  if (NOT_APPROVAL.test(t.toLowerCase().replace(/[^a-z\s]/g, '').trim())) return false
  return isAcknowledgement(t) || /\b(approved?|confirm(ed)?|go ahead|post (it|cheyyu|cheytho)|super|adipoli|kollam|set aanu)\b/i.test(t) && t.length <= 40
}

/**
 * How far one flyer has got. `messages` is its chat, oldest first; only what
 * was said after the list (`fromIso`) and before the client's next list
 * (`untilIso`) belongs to this flyer.
 */
export function flyerProgress(messages: readonly DeskMessage[], fromIso: string, untilIso: string | null): FlyerProgress {
  const p: FlyerProgress = { stage: 'new', designs: 0, pages: null, unreadDesigns: 0, corrections: 0, firstDesignAt: null, approvedAt: null, designText: null }
  const designTexts: (string | null)[] = []
  for (const m of messages) {
    if (m.sent_at <= fromIso || (untilIso && m.sent_at >= untilIso)) continue
    if (isDesign(m)) {
      p.designs++
      designTexts.push(m.media_text ?? null)
      p.firstDesignAt ??= m.sent_at
      if (m.media_text?.trim()) p.designText = m.media_text.trim()
      // Pages posted in one go straddle the client's "ok": a design within a few minutes
      // of the approval is part of what was approved, not a new version.
      const sameBurst = p.approvedAt !== null && Date.parse(m.sent_at) - Date.parse(p.approvedAt) <= SAME_BURST_MINUTES * 60_000
      if (!sameBurst) { p.stage = 'sent'; p.approvedAt = null }
      continue
    }
    // Before a design the client is still sending material; Cirqle's own talk changes nothing.
    if (m.from_cirqle || p.stage === 'new') continue
    if (m.type === 'text' && isApproval(m.body || '')) {
      p.stage = 'approved'
      p.approvedAt = m.sent_at
    } else if (p.stage === 'sent' || p.stage === 'approved') {
      // One round of changes however many messages it takes the client to say it.
      p.corrections++
      p.stage = 'changes'
      p.approvedAt = null
    }
  }
  const counted = countPages(designTexts)
  p.pages = counted.pages
  p.unreadDesigns = counted.unread
  return p
}

/** "2 pages" for the desk and its alerts; says so when the count rests on pictures that could not all be read. */
export function pagesLabel(p: Pick<FlyerProgress, 'designs' | 'pages' | 'unreadDesigns'>): string {
  if (!p.designs) return ''
  const pictures = `${p.designs} picture${p.designs === 1 ? '' : 's'} sent`
  if (!p.pages) return `${pictures}, pages not counted`
  const unread = p.unreadDesigns ? `, ${p.unreadDesigns} not read` : ''
  return `${p.pages} page${p.pages === 1 ? '' : 's'} (${pictures}${unread})`
}

export const STAGE_LABEL: Record<FlyerStage, string> = {
  new: 'Not designed yet',
  sent: 'Design sent, waiting for the client',
  changes: 'Client asked for changes',
  approved: 'Approved by the client',
}

/** Flyers that need a nudge the evening before: the offer starts by tomorrow and the client has no finished design. */
export function isBehind(stage: FlyerStage, offerStart: string, today: string, tomorrow: string): boolean {
  return (stage === 'new' || stage === 'changes') && offerStart >= today && offerStart <= tomorrow
}

// ── Reading a calendar item's notes back ────────────────────────────────────

export interface OfferSource { messageId: string; chatId: string }

/** The WhatsApp message and chat an offer item came from, from the tag in its notes. */
export function offerSource(notes: string | null | undefined): OfferSource | null {
  const m = String(notes || '').match(/\[whatsapp:(\S+) chat:([^\]\s]+)\]/)
  return m ? { messageId: m[1], chatId: m[2] } : null
}

/** The price list alone, as the client sent it (every part merged), ready to paste into Offer Studio. */
export function offerList(notes: string | null | undefined): string {
  return parseOfferNotes(notes).list.join('\n')
}

/** What the client said about the flyer after the list: remarks, voice notes, photos. */
export function offerFollowUps(notes: string | null | undefined): string[] {
  const p = parseOfferNotes(notes)
  return [...p.voice.filter(l => !l.startsWith('[')), ...p.followUps.map(l => l.replace(/\s*\[note:[^\]]*\]$/, '').replace(/^- /, ''))]
}

// ── Price checks ────────────────────────────────────────────────────────────

export interface PricedProduct { name: string; key: string; price: number }

const TRAILING_PRICE = /[\s\-:=.₹]\s*(?:rs\.?\s*)?(\d{1,5}(?:\.\d{1,2})?)\s*(?:\/-|rs\.?|₹)?\s*$/i

/** The products and prices in a list. Lines that are not "name, then price" are left out. */
export function pricedProducts(list: string): PricedProduct[] {
  const out: PricedProduct[] = []
  for (const raw of String(list || '').split('\n')) {
    const l = raw.trim()
    if (!isPriceLine(l)) continue
    const m = l.match(TRAILING_PRICE)
    if (!m || m.index === undefined) continue
    const name = l.slice(0, m.index).replace(/[\s\-:=.₹]+$/, '').trim()
    const key = name.toLowerCase().replace(/[^a-z0-9ഀ-ൿ]+/g, '')
    const price = Number(m[1])
    if (key.length >= 2 && price > 0) out.push({ name, key, price })
  }
  return out
}

/** A price this far from the client's last one for the same product is worth a second look. */
export const PRICE_JUMP = 0.5
export const MAX_WARNINGS = 6

/**
 * Things to check before the flyer is made: a product listed twice at two
 * prices, a line with no price, and a price far from what this client last
 * listed for the same product (a slipped digit is the usual cause).
 * `earlier` is the client's earlier lists, newest first.
 */
export function priceWarnings(list: string, earlier: readonly string[] = []): string[] {
  const warnings: string[] = []
  const products = pricedProducts(list)

  const seen = new Map<string, PricedProduct>()
  for (const p of products) {
    const first = seen.get(p.key)
    if (first && first.price !== p.price) warnings.push(`${p.name} is listed twice: ${first.price} and ${p.price}.`)
    else if (!first) seen.set(p.key, p)
  }

  for (const raw of String(list || '').split('\n')) {
    const l = raw.trim()
    // A product name with no number at all. Headings, dates and "Buy 1 get 1" lines carry digits or are short.
    if (l.length >= 6 && l.length <= 60 && !/\d/.test(l) && /^[A-Za-zഀ-ൿ][A-Za-zഀ-ൿ\s.&'-]+$/.test(l) && products.length >= 4) {
      warnings.push(`No price on "${l}".`)
    }
  }

  const last = new Map<string, number>()
  for (const old of earlier) for (const p of pricedProducts(old)) if (!last.has(p.key)) last.set(p.key, p.price)
  for (const p of seen.values()) {
    const before = last.get(p.key)
    if (before && Math.abs(p.price - before) / before >= PRICE_JUMP) warnings.push(`${p.name}: ${p.price} now, ${before} last time.`)
  }
  return warnings.slice(0, MAX_WARNINGS)
}

// ── When the client approves ────────────────────────────────────────────────

/** Written in the notes once an approved flyer has been renamed and closed, so it is done once. */
export const APPROVED_MARK = '[approved:'
/** Beside the approval: the page count the task was billed on, so a page that turns up later is noticed. */
export const PAGES_MARK = '[pages:'
export function notesWithApproval(notes: string | null | undefined, day: string, pages?: number | null): string {
  return `${String(notes || '').trimEnd()}\n\nApproved by the client in WhatsApp on ${day}. ${APPROVED_MARK}${day}]${pages ? ` ${PAGES_MARK}${pages}]` : ''}`
}
/** The page count written at approval, or null for a flyer approved without one. */
export function approvedPages(notes: string | null | undefined): number | null {
  const m = String(notes || '').match(/\[pages:(\d+)\]/)
  return m ? Number(m[1]) : null
}
/** The same notes with the page count brought up to date. */
export function notesWithPages(notes: string, pages: number): string {
  return notes.replace(/\[pages:\d+\]/, `${PAGES_MARK}${pages}]`)
}

/** A usable offer title: a few words, not a price line, not the placeholder. */
export function cleanOfferTitle(raw: unknown): string | null {
  const t = String(typeof raw === 'string' ? raw : '').replace(/\s+/g, ' ').replace(/^["'“”\s]+|["'“”\s.]+$/g, '').trim()
  if (t.length < 3 || t.length > 60 || !/[A-Za-z\u0D00-\u0D7F]{3}/.test(t)) return null
  if (isPriceLine(t) || /^untitled$/i.test(t)) return null
  // Flyer headlines are printed in capitals: "TASTY TREASURES" reads better as "Tasty Treasures".
  return /[a-z]/.test(t) ? t : t.toLowerCase().replace(/(^|[\s\-&])([a-z])/g, (_, gap: string, c: string) => gap + c.toUpperCase())
}

export interface CampaignRow {
  title: string | null; offer_date: string | null; offer_date_from: string | null; offer_date_to: string | null; created_at: string
}

/** The title of the Offer Studio offer whose dates cover this flyer's first day (the newest, when several do). */
export function campaignTitle(campaigns: readonly CampaignRow[], offerStart: string): string | null {
  const match = campaigns
    .filter(c => c.offer_date === offerStart || (!!c.offer_date_from && !!c.offer_date_to && c.offer_date_from <= offerStart && offerStart <= c.offer_date_to))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  for (const c of match) { const t = cleanOfferTitle(c.title); if (t) return t }
  return null
}

export const TITLE_PROMPT =
  'You are given the text read off a supermarket offer flyer. Find the offer title: the big headline that names THIS offer, ' +
  'such as "Tasty Treasures", "Weekend Offer", "Onam Mega Sale" or "Friday Fresh Deals". ' +
  'It is not the shop name, an address, a date or validity line, a product or a price. ' +
  'It is also not a badge for a long-running occasion that sits beside the headline on every flyer of the season ' +
  '("4th Anniversary Fest", "5 Years of Trust", "Ramadan Kareem"): when the flyer has both such a badge and its own headline, answer the headline. ' +
  'Respond with ONLY a JSON object: {"title": "<the headline as printed>"} or {"title": ""} when no headline is clear.'
