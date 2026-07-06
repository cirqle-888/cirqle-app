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
): Promise<string | null> {
  const key = process.env.GROQ_API_KEY
  if (!key) return null

  try {
    const blob = audio instanceof Blob ? audio : new Blob([audio], { type: 'audio/webm' })
    const form = new FormData()
    form.append('file', blob, fileName)
    form.append('model', MODEL)
    form.append('response_format', 'json')

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
