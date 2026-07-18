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
  // Default to a NON-reasoning instruct model: it answers this extraction task
  // in ~57 tokens and stops cleanly. Reasoning models (Qwen3, gpt-oss) spend
  // the whole budget on hidden thinking and return EMPTY content — measured:
  // qwen3.6-27b burned 1200/1200 tokens and produced nothing.
  // Override per-deployment with GROQ_MODEL; Groq retires model ids regularly,
  // so check console.groq.com/docs/models if a 404 appears.
  const model = opts?.model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'

  // Reasoning models emit <think> chain-of-thought and accept reasoning_format
  // to suppress it. Plain instruct models REJECT that parameter outright
  // ("`reasoning_format` is not supported with this model", HTTP 400), so only
  // send it where it applies — otherwise setting GROQ_MODEL to an instruct
  // model hard-fails every AI call.
  const isReasoning = /qwen|gpt-oss|deepseek-r1|reason/i.test(model)
  // Reasoning models need headroom for the hidden thinking on top of the answer.
  const maxTokens = opts?.maxTokens ?? (isReasoning ? 2048 : 300)

  // Deliberately NOT using response_format: { type: 'json_object' } — Groq
  // enforces that strictly server-side and a leaked <think> block fails the
  // validation with a hard 400. Instead: prompt-instruct JSON-only output and
  // parse leniently below. Soft failure (empty object) beats a hard error.
  const buildBody = (withReasoningFormat: boolean) => JSON.stringify({
    model,
    temperature: 0,
    max_tokens: maxTokens,
    ...(withReasoningFormat ? { reasoning_format: 'hidden' } : {}),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
  })

  const url = 'https://api.groq.com/openai/v1/chat/completions'
  const post = (body: string) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body,
  })

  // Free-tier per-minute limits can throw a transient 429; retry a couple times.
  let res!: Response
  let sentReasoningFormat = isReasoning
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await post(buildBody(sentReasoningFormat))
    // Self-heal if our reasoning-model guess was wrong for this model id.
    if (res.status === 400 && sentReasoningFormat) {
      const peek = await res.clone().text().catch(() => '')
      if (/reasoning_format/i.test(peek)) {
        sentReasoningFormat = false
        res = await post(buildBody(false))
      }
    }
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
