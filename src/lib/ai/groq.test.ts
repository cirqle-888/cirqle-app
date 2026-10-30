import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callGroqJSON, callGroqText } from './groq'

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })

describe('Groq callers', () => {
  beforeEach(() => vi.stubEnv('GROQ_API_KEY', 'test-key'))
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('callGroqText returns long text with quotes and line breaks intact', async () => {
    const fetch = vi.fn(async () => reply('<think>hidden</think>A "bold" prompt\nwith two lines'))
    vi.stubGlobal('fetch', fetch)
    expect(await callGroqText('sys', 'user', { maxTokens: 1500, temperature: 0.4 })).toBe('A "bold" prompt\nwith two lines')
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    expect(body).toMatchObject({ max_tokens: 1500, temperature: 0.4 })
  })

  it('callGroqJSON still parses JSON and defaults to temperature 0', async () => {
    const fetch = vi.fn(async () => reply('Sure: {"result": "ok"}'))
    vi.stubGlobal('fetch', fetch)
    expect(await callGroqJSON('sys', 'user')).toEqual({ result: 'ok' })
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    expect(body.temperature).toBe(0)
  })

  it('callGroqJSON gives {} for an answer that is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply('no json here')))
    expect(await callGroqJSON('sys', 'user')).toEqual({})
  })
})
