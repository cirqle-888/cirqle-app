/**
 * Voice transcription via Groq Whisper (free tier) — Cirqle Connect Wave C.
 *
 * One place that knows how to call the audio/transcriptions endpoint, in the
 * same spirit as callGroqJSON in ./groq.ts. Uses the same GROQ_API_KEY.
 *
 * Returns null (never throws) when transcription is unavailable — voice notes
 * stay fully usable without a transcript.
 */

const GROQ_AUDIO_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const MODEL = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo'

export async function transcribeAudio(
  audio: Blob | ArrayBuffer,
  fileName = 'voice.webm',
  /** ISO language code ("ml") to stop Whisper guessing a neighbouring language. */
  language?: string,
): Promise<string | null> {
  const key = process.env.GROQ_API_KEY
  if (!key) return null

  try {
    const blob = audio instanceof Blob ? audio : new Blob([audio], { type: 'audio/webm' })
    const form = new FormData()
    form.append('file', blob, fileName)
    form.append('model', MODEL)
    form.append('response_format', 'json')
    if (language) form.append('language', language)

    const res = await fetch(GROQ_AUDIO_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    })
    if (!res.ok) {
      console.warn('[transcribe] Groq returned', res.status, await res.text().catch(() => ''))
      return null
    }
    const json = await res.json() as { text?: string }
    const text = (json.text || '').trim()
    return text || null
  } catch (err) {
    console.warn('[transcribe] failed:', err)
    return null
  }
}

const GROQ_TRANSLATE_URL = 'https://api.groq.com/openai/v1/audio/translations'
// The full model, not turbo: turbo cannot translate, and it mishears Malayalam badly.
const TRANSLATE_MODEL = process.env.GROQ_WHISPER_TRANSLATE_MODEL || 'whisper-large-v3'

/**
 * What a voice note means, in English, whatever language it was spoken in.
 *
 * Whisper writes Malayalam badly (it comes back as Tamil, Gurmukhi or invented
 * English), but its translate mode keeps the meaning: on Cirqle's own client voice
 * notes (checked 14 Nov 2026) transcription gave nonsense where translation gave
 * "Change the rate of the pickle to 95". Returns null (never throws) when unavailable.
 */
export async function translateAudio(audio: Blob | ArrayBuffer, fileName = 'voice.webm'): Promise<string | null> {
  const key = process.env.GROQ_API_KEY
  if (!key) return null
  try {
    const blob = audio instanceof Blob ? audio : new Blob([audio], { type: 'audio/webm' })
    const form = new FormData()
    form.append('file', blob, fileName)
    form.append('model', TRANSLATE_MODEL)
    form.append('response_format', 'json')
    form.append('temperature', '0')
    const res = await fetch(GROQ_TRANSLATE_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form })
    if (!res.ok) {
      console.warn('[transcribe] Groq translation returned', res.status, await res.text().catch(() => ''))
      return null
    }
    const text = (((await res.json()) as { text?: string }).text || '').trim()
    return text || null
  } catch (err) {
    console.warn('[transcribe] translation failed:', err)
    return null
  }
}
