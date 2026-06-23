/**
 * Generic Groq chat-completions caller — the ONE place that knows how to
 * talk to Groq (auth, retry-on-429, error surfacing, JSON extraction).
 * Every AI-parsing feature (request capture, offer product bulk-paste, ...)
 * builds on this instead of each making its own HTTP call, so there is
 * exactly one provider integration to swap if it ever needs to change again
 * (already swapped once: Gemini → Groq).
 *
 * Free tier, no billing required — get a key at console.groq.com/keys.
 */

export async function callGroqJSON(
  systemPrompt: string,
  userText: string,
  opts?: { model?: string; maxTokens?: number },
): Promise<any> {
  const key = process.env.GROQ_API_KEY
  if (!key) throw new Error('AI parsing is not configured (set GROQ_API_KEY).')
  const model = opts?.model || process.env.GROQ_MODEL || 'qwen/qwen3-32b'

  const body = JSON.stringify({
    model,
    temperature: 0,
    max_tokens: opts?.maxTokens ?? 300,
    response_format: { type: 'json_object' },
    // Qwen3 (and other Groq "reasoning" models) prepend <think>...</think>
    // chain-of-thought before the actual answer by default — that breaks
    // Groq's strict json_object validator since the raw content isn't pure
    // JSON. reasoning_format: 'hidden' strips the thinking tokens server-side
    // so only the final JSON answer comes back. Harmless no-op on
    // non-reasoning models (e.g. Llama).
    reasoning_format: 'hidden',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
  })

  const url = 'https://api.groq.com/openai/v1/chat/completions'
  // Free-tier per-minute limits can throw a transient 429; retry a couple times.
  let res!: Response
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body,
    })
    if (res.ok || res.status !== 429) break
    if (attempt < 2) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
  }
  if (!res.ok) {
    // Surface Groq's real reason (quota exceeded, model not found, key invalid…)
    const detail = await res.text().catch(() => '')
    let msg = ''
    try { msg = JSON.parse(detail)?.error?.message || '' } catch { /* not json */ }
    throw new Error(`AI request failed (${res.status})${msg ? `: ${msg}` : ''}.`)
  }
  const data = await res.json()
  const raw = data?.choices?.[0]?.message?.content || '{}'
  const match = raw.match(/\{[\s\S]*\}/)
  try { return JSON.parse(match ? match[0] : raw) } catch { return {} }
}
