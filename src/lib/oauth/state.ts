import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Signed OAuth `state` — prevents CSRF / token-poisoning on provider callbacks.
 *
 * Producers (login routes) call signOAuthState({ clientId, employeeId });
 * consumers (callback routes) call verifyOAuthState() and MUST also require a
 * signed-in employee session before persisting tokens.
 *
 * Format: base64url(JSON payload + ts) + "." + HMAC-SHA256 signature.
 * States expire after 15 minutes.
 */

const MAX_AGE_MS = 15 * 60 * 1000

function secret(): string {
  const s = process.env.OAUTH_STATE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!s) throw new Error('OAUTH_STATE_SECRET or SUPABASE_SERVICE_ROLE_KEY must be set to sign OAuth state')
  return s
}

export function signOAuthState(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify({ ...payload, ts: Date.now() })).toString('base64url')
  const sig = createHmac('sha256', secret()).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifyOAuthState<T extends Record<string, unknown>>(
  state: string | null | undefined,
): (T & { ts: number }) | null {
  if (!state) return null
  const dot = state.lastIndexOf('.')
  if (dot <= 0) return null
  const body = state.slice(0, dot)
  const sig = state.slice(dot + 1)
  let given: Buffer
  try {
    given = Buffer.from(sig, 'base64url')
  } catch {
    return null
  }
  const expected = createHmac('sha256', secret()).update(body).digest()
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'))
    if (typeof payload.ts !== 'number' || Date.now() - payload.ts > MAX_AGE_MS) return null
    return payload
  } catch {
    return null
  }
}
