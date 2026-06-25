/**
 * Capture Engine — AI classification.
 *
 * One Groq call decides which module a snippet belongs to. It is deliberately
 * classification-only: the field extraction lives in each module's existing
 * specialized parser (aiParse, aiParseOfferProducts, …), which the adapters
 * reuse — so there is no second copy of that logic to drift.
 *
 * `parseClassification` is a pure function (no network) so it is unit-tested
 * with canned model output; `classifyText` just wires it to the shared Groq
 * caller (src/lib/ai/groq.ts).
 */

import { callGroqJSON } from '@/lib/ai/groq'
import type { CaptureClassification, CaptureType } from './types'

/** Below this the classifier's pick is treated as 'unknown' → user chooses. */
export const CONFIDENCE_THRESHOLD = 0.45

const ALLOWED: CaptureType[] = ['request', 'offer', 'invoice', 'client', 'task', 'quotation', 'unknown']

const SYSTEM_PROMPT =
  `You are a router for a creative agency's operations app. Classify ONE pasted snippet ` +
  `(a WhatsApp message, email, note, product list, contact card, etc.) into exactly one destination:\n` +
  `- "request": a client asking for creative work to be done (e.g. "need a menu design by friday")\n` +
  `- "offer": a list of products with prices, or a promotional offer sheet\n` +
  `- "invoice": text that is, or refers to, a bill / invoice / payment due\n` +
  `- "client": contact details for a customer (name + phone/email/address, a vCard)\n` +
  `- "task": an internal to-do for the team (not a client-facing request)\n` +
  `- "quotation": a request for a price quote / RFQ / estimate\n` +
  `- "unknown": none of the above, or too ambiguous to tell\n` +
  `Respond with ONLY JSON: {"type": <one of the above>, "confidence": <0..1>, "client_hint": <name or null>}. ` +
  `Do not explain. Do not use <think> tags.`

/** Map raw model JSON → a typed classification, applying the confidence gate. */
export function parseClassification(raw: any): CaptureClassification {
  let type = String(raw?.type ?? '').toLowerCase().trim() as CaptureType
  if (!ALLOWED.includes(type)) type = 'unknown'

  let confidence = Number(raw?.confidence)
  if (!Number.isFinite(confidence)) confidence = type === 'unknown' ? 0 : 0.5
  confidence = Math.max(0, Math.min(1, confidence))

  const rawHint = raw?.client_hint
  const hint = rawHint != null && String(rawHint).trim() ? String(rawHint).trim() : null
  const hints = hint ? { client: hint } : undefined

  // Low-confidence guess → route to review rather than commit to a module.
  if (type !== 'unknown' && confidence < CONFIDENCE_THRESHOLD) {
    return { type: 'unknown', confidence, hints }
  }
  return { type, confidence, hints }
}

export async function classifyText(text: string): Promise<CaptureClassification> {
  const raw = await callGroqJSON(SYSTEM_PROMPT, text, { maxTokens: 200 })
  return parseClassification(raw)
}
