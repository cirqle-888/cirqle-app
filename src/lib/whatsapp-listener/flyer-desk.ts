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
import { isPriceLine } from './offer-plan'

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
  /** Designs Cirqle posted for this flyer (photos or files). */
  designs: number
  /** Times the client came back with changes after a design. */
  corrections: number
  firstDesignAt: string | null
  approvedAt: string | null
  /** What the newest design says (read off the photo), for finding its offer title. */
  designText: string | null
}

const isDesign = (m: DeskMessage) => m.from_cirqle && (m.type === 'image' || m.type === 'document')

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
  const p: FlyerProgress = { stage: 'new', designs: 0, corrections: 0, firstDesignAt: null, approvedAt: null, designText: null }
  for (const m of messages) {
    if (m.sent_at <= fromIso || (untilIso && m.sent_at >= untilIso)) continue
    if (isDesign(m)) {
      p.designs++
      p.firstDesignAt ??= m.sent_at
      if (m.media_text?.trim()) p.designText = m.media_text.trim()
      p.stage = 'sent'
      p.approvedAt = null
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
  return p
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

/** The price list alone, as the client sent it (plus anything added afterwards), ready to paste into Offer Studio. */
export function offerList(notes: string | null | undefined): string {
  const out: string[] = []
  for (const raw of String(notes || '').split('\n')) {
    const l = raw.trim()
    if (!l || /^\[(whatsapp|added|voice|approved):/.test(l)) continue
    // The voice note and the approval line come after the list and are not part of it.
    if (/^(Voice note from the client|Approved by the client)/.test(l)) break
    if (/^(Read by AI from a photo|Offer list from WhatsApp|Offer date:|Prices are not in the list|Added by the client afterwards)/.test(l)) continue
    out.push(l)
  }
  return out.join('\n')
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
export function notesWithApproval(notes: string | null | undefined, day: string): string {
  return `${String(notes || '').trimEnd()}\n\nApproved by the client in WhatsApp on ${day}. ${APPROVED_MARK}${day}]`
}

/** A usable offer title: a few words, not a price line, not the placeholder. */
export function cleanOfferTitle(raw: unknown): string | null {
  const t = String(typeof raw === 'string' ? raw : '').replace(/\s+/g, ' ').replace(/^["'“”\s]+|["'“”\s.]+$/g, '').trim()
  if (t.length < 3 || t.length > 60 || !/[A-Za-z\u0D00-\u0D7F]{3}/.test(t)) return null
  if (isPriceLine(t) || /^untitled$/i.test(t)) return null
  return t
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
  'You are given the text read off a supermarket offer flyer. Find the offer title: the headline that names the offer, ' +
  'such as "Weekend Offer", "Onam Mega Sale" or "Friday Fresh Deals". It is not the shop name, an address, a date, a product or a price. ' +
  'Respond with ONLY a JSON object: {"title": "<the headline as printed>"} or {"title": ""} when no headline is clear.'
