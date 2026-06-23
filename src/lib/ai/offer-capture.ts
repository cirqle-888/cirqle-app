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
}

const SYSTEM_PROMPT =
  `You extract a list of supermarket/retail products from pasted text (one product per line, in any` +
  ` rough format — e.g. "EASTERN CHILLI POWDER 500GM 109.90" or "Rice 5kg - Rs 350" or "Sugar 42"). For each line, extract:\n` +
  `- name: the product name, title-cased, WITHOUT the weight or price in it\n` +
  `- weight: pack size / quantity if present (e.g. "500g", "1kg", "250ml"), else null\n` +
  `- price: the selling/offer price as a plain number, else null\n` +
  `- mrp: a second, higher "MRP"/"was" price if BOTH an offer price and an original price appear on the same line, else null\n` +
  `Skip blank lines, headers, or lines that aren't actually a product. Do not think out loud, do not explain, ` +
  `do not use <think> tags. Respond with ONLY a JSON object: ` +
  `{ "products": [ { "name": string, "weight": string|null, "price": number|null, "mrp": number|null }, ... ] } — no other text whatsoever.`

export async function aiParseOfferProducts(text: string): Promise<{ products: ParsedOfferProduct[] }> {
  const result = await callGroqJSON(SYSTEM_PROMPT, text, { maxTokens: 4000 })
  const products = Array.isArray(result?.products) ? result.products : []
  return {
    products: products
      .filter((p: any) => p && typeof p.name === 'string' && p.name.trim())
      .map((p: any) => ({
        name: String(p.name).trim(),
        weight: p.weight ? String(p.weight).trim() : null,
        price: typeof p.price === 'number' ? p.price : null,
        mrp: typeof p.mrp === 'number' ? p.mrp : null,
      })),
  }
}
