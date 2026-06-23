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
    // Deliberately NOT using response_format: { type: 'json_object' } —
    // Groq enforces that strictly server-side, and Qwen3 (a "reasoning"
    // model) prepends <think>...</think> chain-of-thought before its answer,
    // which fails that validation with a hard 400 even with
    // reasoning_format: 'hidden' (still observed leaking through). Instead:
    // prompt-instruct JSON-only output, hint reasoning_format to suppress
    // thinking tokens when the model honors it, and parse leniently below
    // (strip any <think> block, then regex out the JSON object). Soft
    // failure (empty object) beats a hard request-level error.
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
    try {
      const parsed = JSON.parse(detail)
      msg = parsed?.error?.message || ''
      // Groq includes the raw model output that failed validation here when
      // response_format enforcement rejects a generation — useful for
      // diagnosing prompt/model issues, so surface a trimmed preview of it.
      const failedGen = parsed?.error?.failed_generation
      if (failedGen) msg += ` | model said: ${String(failedGen).slice(0, 200)}`
    } catch { /* not json */ }
    throw new Error(`AI request failed (${res.status})${msg ? `: ${msg}` : ''}.`)
  }
  const data = await res.json()
  let raw = data?.choices?.[0]?.message?.content || '{}'
  // Defense-in-depth: strip any chain-of-thought block that leaked through
  // despite reasoning_format: 'hidden', before extracting the JSON object.
  raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const match = raw.match(/\{[\s\S]*\}/)
  try { return JSON.parse(match ? match[0] : raw) } catch { return {} }
}
