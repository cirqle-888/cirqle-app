/**
 * The secret in a calendar subscription URL.
 *
 * A calendar client sends no cookie and no Authorization header — it GETs a
 * URL on whatever schedule it likes — so the URL itself has to be the
 * credential. That makes the generator's properties load-bearing rather than
 * incidental:
 *
 *   • crypto randomness, never Math.random(). A predictable token is a
 *     readable calendar for someone who never signed in.
 *   • 32 bytes (256 bits). Guessing is not a threat model at that width.
 *   • base64url, so the token survives being pasted into a phone's
 *     subscription box, an email, and a WhatsApp message without escaping —
 *     '+' and '/' do not.
 *
 * Pure and dependency-free so it can be unit-tested; the write lives in the
 * server action.
 */

/** 32 random bytes, base64url, no padding. */
export function newFeedToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Does this look like a token we issued?
 *
 * The route checks the shape before querying, so a scanner never costs a
 * database round-trip. Deliberately a shape check and nothing more — whether
 * a token is REAL is the unique index's answer, not this function's.
 */
export function looksLikeFeedToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 24
    && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value)
}

/**
 * The address a phone subscribes to.
 *
 * webcal:// rather than https:// — iOS and macOS Calendar, Outlook and Google
 * all treat it as "subscribe to this", where an https link in a browser just
 * downloads a one-off file that never updates again. The scheme swap is the
 * whole difference between a calendar that stays current and a snapshot of
 * today.
 */
export function feedUrl(origin: string, token: string, opts: { webcal?: boolean } = {}): string {
  const clean = origin.replace(/\/$/, '')
  const https = `${clean}/api/calendar/posting/${token}`
  if (opts.webcal === false) return https
  return https.replace(/^https?:\/\//, 'webcal://')
}
