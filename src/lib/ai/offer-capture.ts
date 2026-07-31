/**
 * Bulk-paste product parsing for the Offer Intake form — a client pastes a
 * raw product list (copied from a price sheet, WhatsApp message, or typed
 * freehand) and this extracts each line into a structured product. Built on
 * the same shared Groq caller as request capture (src/lib/ai/groq.ts) —
 * no second AI integration.
 */

import { callGroqJSON } from './groq'

export interface ParsedOfferProduct {
  name: string
  price?: number | null
  mrp?: number | null
  weight?: string | null
  badge?: string | null
}

const SYSTEM_PROMPT =
  `You extract a list of supermarket/retail products from pasted text (usually a WhatsApp offer list).\n` +
  `RULES:\n` +
  `- EXACTLY ONE product per LINE. A newline is the ONLY product separator.\n` +
  `- "/", "&", "+", "-", "," INSIDE a line are part of the product NAME, never a separator. ` +
  `e.g. "Sweet / Masala Number 63" is ONE product named "Sweet / Masala Number" priced 63.\n` +
  `- Keep the pack size / weight IN the name if present (e.g. "Bru Coffee 200g"), and also copy it to the weight field.\n` +
  `- NEVER translate, transliterate or romanise a product name. Keep the ORIGINAL SCRIPT ` +
  `character for character: Malayalam stays Malayalam, Hindi stays Hindi, Arabic stays Arabic. ` +
  `"ചെറുപയർ 500GM" must come back as "ചെറുപയർ 500GM" — NOT "Cherupayar 500Gm". ` +
  `This is a data-entry job, not a translation job.\n` +
  `For each line extract:\n` +
  `- name: the product name, INCLUDING any pack size, WITHOUT the price. ` +
  `Title-case ONLY plain English names; leave every other script exactly as written\n` +
  `- weight: pack size / quantity if present (e.g. "500g", "1kg", "250ml"), else null\n` +
  `- price: the selling/offer price as a plain number (handles "109.90", "Rs 350", "265/-", "@ 145", "35rs"), else null\n` +
  `- mrp: a second, HIGHER "MRP"/"was"/original price if BOTH prices appear on the same line, else null. ` +
  `The lower number is always the offer price. "(Save X)" means mrp = price + X.\n` +
  `- badge: a promo tag if the line carries one (e.g. "NEW", "HOT", "OFFER", ⚡/🔥 prefixes, "Buy 1 Get 1"), else null\n` +
  `Skip blank lines, greetings, dates, shop names, and headers — lines that aren't actually a product.\n` +
  `Do not think out loud, do not explain, do not use <think> tags. Respond with ONLY a JSON object: ` +
  `{ "products": [ { "name": string, "weight": string|null, "price": number|null, "mrp": number|null, "badge": string|null }, ... ] } — no other text whatsoever.`

export async function aiParseOfferProducts(
  text: string,
  hint?: string,
): Promise<{ products: ParsedOfferProduct[] }> {
  // An optional user-supplied correction (e.g. "the number after each name is
  // MRP, not offer price") rides along as an extra system rule. Kept separate
  // from the pasted text so the model can't confuse it with a product line.
  const system = hint?.trim()
    ? `${SYSTEM_PROMPT}\nADDITIONAL USER INSTRUCTION (follow it, it overrides defaults): ${hint.trim().slice(0, 500)}`
    : SYSTEM_PROMPT
  const result = await callGroqJSON(system, text, { maxTokens: 4000 })
  const products = Array.isArray(result?.products) ? result.products : []
  return {
    products: products
      .filter((p: any) => p && typeof p.name === 'string' && p.name.trim())
      .map((p: any) => {
        const baseName = String(p.name).trim()
        const w = p.weight ? String(p.weight).trim() : ''
        // Weight lives in the product name as a single column, so fold any
        // separately-detected pack size back into the name (unless it's
        // already present) and leave the structured weight field empty.
        const name = w && !baseName.toLowerCase().includes(w.toLowerCase())
          ? `${baseName} ${w}`
          : baseName
        return {
          name,
          weight: null,
          price: typeof p.price === 'number' ? p.price : null,
          mrp: typeof p.mrp === 'number' ? p.mrp : null,
          badge: typeof p.badge === 'string' && p.badge.trim() ? p.badge.trim() : null,
        }
      }),
  }
}
