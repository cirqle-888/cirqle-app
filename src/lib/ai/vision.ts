/**
 * Reading text out of a photo (a handwritten price list, a screenshot) via a
 * Groq vision model.
 *
 * OFF unless `GROQ_VISION_MODEL` is set. There is deliberately no default
 * model id: Groq retires model ids regularly, and a stale default would fail
 * every photo. Offer Studio already runs a vision model; use the same id here
 * (see its GROQ_VISION_MODEL / photo-notes route) and check
 * console.groq.com/docs/models when it 404s.
 *
 * Returns null (never throws) when reading is unavailable or fails — the
 * caller keeps the photo itself, so nothing is lost.
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
/** Groq's limit for base64 images is 4 MB of encoded data; raw bytes must stay well under it. */
const MAX_IMAGE_BYTES = 2.8 * 1024 * 1024
const READABLE = new Set(['image/jpeg', 'image/png', 'image/webp'])

export function isImageReadingConfigured(): boolean {
  return !!process.env.GROQ_API_KEY && !!process.env.GROQ_VISION_MODEL
}

export async function readImageText(bytes: ArrayBuffer, mime: string): Promise<string | null> {
  const key = process.env.GROQ_API_KEY
  const model = process.env.GROQ_VISION_MODEL
  const type = (mime || '').toLowerCase()
  if (!key || !model) return null
  if (!READABLE.has(type) || bytes.byteLength > MAX_IMAGE_BYTES) return null

  try {
    const dataUrl = `data:${type};base64,${Buffer.from(bytes).toString('base64')}`
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(40_000),
      body: JSON.stringify({
        model,
        temperature: 0,
        max_completion_tokens: 900,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'This photo was sent to a design agency by a client, usually a shop. Copy out exactly what is written in it: ' +
                'product names, quantities, prices, dates and any instruction. Keep the original language and spelling. ' +
                'One item per line. Do not add, guess, translate or explain. If there is no readable writing, answer with the single word NONE.',
            },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
      }),
    })
    if (!res.ok) {
      console.warn('[vision] Groq returned', res.status, (await res.text().catch(() => '')).slice(0, 200))
      return null
    }
    const json = await res.json() as { choices?: { message?: { content?: string } }[] }
    const text = (json.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    return !text || /^none\.?$/i.test(text) ? null : text
  } catch (err) {
    console.warn('[vision] failed:', err)
    return null
  }
}
