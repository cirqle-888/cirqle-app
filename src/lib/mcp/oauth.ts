/**
 * OAuth 2.1 for the MCP endpoint, so Claude on the web, phone and desktop
 * (and other AI apps that sign in with OAuth) can connect to Cirqle with a
 * normal "Connect" button instead of a pasted token.
 *
 * Flow (what Claude does, per MCP authorization):
 *   1. POST /api/mcp without a token → 401 pointing at the resource metadata.
 *   2. Reads /.well-known/oauth-protected-resource and
 *      /.well-known/oauth-authorization-server.
 *   3. Registers itself: POST /api/oauth/register (dynamic registration).
 *   4. Sends the person to /oauth/authorize. They must be signed in to Cirqle
 *      as an admin and press Allow.
 *   5. Swaps the code for tokens at /api/oauth/token (PKCE S256 required).
 *
 * STATELESS: clients, codes and tokens are signed strings (HMAC-SHA256 with a
 * key derived from MCP_API_TOKEN), so nothing is stored and no migration is
 * needed. Changing MCP_API_TOKEN in Vercel signs everyone out at once.
 * Access tokens last an hour; refresh tokens 30 days and are replaced on
 * every refresh.
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto'

export const SCOPE = 'cirqle'
export const ACCESS_TTL = 60 * 60
export const REFRESH_TTL = 30 * 24 * 60 * 60
export const CODE_TTL = 5 * 60

/** Seconds since the epoch: the clock every check below takes. */
export const nowSeconds = () => Math.floor(Date.now() / 1000)

type Kind = 'cqc' | 'cqa' | 'cqt' | 'cqr' // client, code, access token, refresh token

function signingKey(secret = process.env.MCP_API_TOKEN): Buffer | null {
  return secret ? createHmac('sha256', secret).update('cirqle-mcp-oauth-v1').digest() : null
}

function mac(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data).digest('base64url')
}

export function signToken(kind: Kind, payload: Record<string, unknown>, secret?: string): string | null {
  const key = signingKey(secret)
  if (!key) return null
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${kind}.${body}.${mac(key, `${kind}.${body}`)}`
}

export function readToken<T extends Record<string, unknown>>(token: string | null | undefined, kind: Kind, nowSec: number, secret?: string): T | null {
  const key = signingKey(secret)
  if (!key || !token || token.length > 4000) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== kind) return null
  const want = Buffer.from(mac(key, `${parts[0]}.${parts[1]}`))
  const got = Buffer.from(parts[2])
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  let payload: T
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) } catch { return null }
  const exp = (payload as { exp?: unknown }).exp
  if (typeof exp === 'number' && exp < nowSec) return null
  return payload
}

const sha = (s: string) => createHash('sha256').update(s).digest('base64url')
/** Short fingerprint of a client id, carried inside codes and tokens. */
const clientTag = (clientId: string) => sha(clientId).slice(0, 22)

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//

/** Redirect URIs a client may register: any https URL, or a loopback http one (Claude Code). */
export function validRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length > 500) return false
  try {
    const u = new URL(uri)
    if (u.hash) return false
    if (u.protocol === 'https:') return true
    return LOOPBACK.test(uri)
  } catch { return false }
}

/** Loopback redirects match on everything but the port (RFC 8252 §7.3); others must match exactly. */
export function sameRedirect(registered: string, given: string): boolean {
  if (registered === given) return true
  if (!LOOPBACK.test(registered) || !LOOPBACK.test(given)) return false
  const strip = (s: string) => { const u = new URL(s); u.port = ''; return u.toString().replace('://127.0.0.1', '://localhost') }
  return strip(registered) === strip(given)
}

export interface ClientInfo { r: string[]; n: string; iat: number }

export function registerClient(meta: { redirect_uris?: unknown; client_name?: unknown }, nowSec: number, secret?: string) {
  const uris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris : []
  if (!uris.length || uris.length > 5 || !uris.every(validRedirectUri)) {
    return { ok: false as const, error: 'invalid_redirect_uri', description: 'Give 1-5 https (or loopback http) redirect URIs.' }
  }
  const name = typeof meta.client_name === 'string' ? meta.client_name.slice(0, 80) : 'AI app'
  const clientId = signToken('cqc', { r: uris, n: name, iat: nowSec }, secret)
  if (!clientId) return { ok: false as const, error: 'server_error', description: 'OAuth is not configured on this server.' }
  return { ok: true as const, clientId, redirectUris: uris as string[], name }
}

export function clientInfo(clientId: string | null | undefined, nowSec: number, secret?: string): ClientInfo | null {
  return readToken<ClientInfo & Record<string, unknown>>(clientId, 'cqc', nowSec, secret)
}

export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false
  const a = Buffer.from(sha(verifier))
  const b = Buffer.from(challenge)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface AuthorizeRequest {
  client_id: string; redirect_uri: string; code_challenge: string; code_challenge_method: string
  response_type: string; state?: string; scope?: string
}

/**
 * Checks an authorize request. `redirectOk` says whether errors may be sent
 * back to the redirect URI (only once the client and URI are proven).
 */
export function checkAuthorize(p: Partial<AuthorizeRequest>, nowSec: number, secret?: string) {
  const client = clientInfo(p.client_id, nowSec, secret)
  if (!client) return { ok: false as const, redirectOk: false, error: 'invalid_client', description: 'This app is not registered with Cirqle. Remove the connector and add it again.' }
  const redirect = client.r.find(r => sameRedirect(r, p.redirect_uri || ''))
  if (!p.redirect_uri || !redirect) return { ok: false as const, redirectOk: false, error: 'invalid_request', description: 'The return address does not match the app’s registration.' }
  if (p.response_type !== 'code') return { ok: false as const, redirectOk: true, error: 'unsupported_response_type', description: 'Only the code flow is supported.' }
  if (p.code_challenge_method !== 'S256' || !p.code_challenge || p.code_challenge.length < 43) {
    return { ok: false as const, redirectOk: true, error: 'invalid_request', description: 'PKCE with S256 is required.' }
  }
  return { ok: true as const, client }
}

export function issueCode(p: { clientId: string; redirectUri: string; challenge: string; sub: string }, nowSec: number, secret?: string): string | null {
  return signToken('cqa', { c: clientTag(p.clientId), u: p.redirectUri, x: p.challenge, sub: p.sub, exp: nowSec + CODE_TTL }, secret)
}

function tokenPair(sub: string, clientId: string, nowSec: number, secret?: string) {
  const access = signToken('cqt', { sub, c: clientTag(clientId), exp: nowSec + ACCESS_TTL }, secret)
  const refresh = signToken('cqr', { sub, c: clientTag(clientId), exp: nowSec + REFRESH_TTL, iat: nowSec }, secret)
  if (!access || !refresh) return null
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: SCOPE, sub }
}

type TokenResult =
  | { ok: true; body: NonNullable<ReturnType<typeof tokenPair>> }
  | { ok: false; error: string; description: string }

/** The token endpoint: authorization_code (with PKCE) or refresh_token. */
export function exchange(form: Record<string, string>, nowSec: number, secret?: string): TokenResult {
  const clientId = form.client_id || ''
  if (!clientInfo(clientId, nowSec, secret)) return { ok: false, error: 'invalid_client', description: 'Unknown client.' }
  if (form.grant_type === 'authorization_code') {
    const code = readToken<{ c: string; u: string; x: string; sub: string }>(form.code, 'cqa', nowSec, secret)
    if (!code) return { ok: false, error: 'invalid_grant', description: 'The code is invalid or expired.' }
    if (code.c !== clientTag(clientId)) return { ok: false, error: 'invalid_grant', description: 'The code was issued to another client.' }
    if (!form.redirect_uri || !sameRedirect(code.u, form.redirect_uri)) return { ok: false, error: 'invalid_grant', description: 'redirect_uri does not match.' }
    if (!form.code_verifier || !pkceMatches(form.code_verifier, code.x)) return { ok: false, error: 'invalid_grant', description: 'PKCE verification failed.' }
    const body = tokenPair(code.sub, clientId, nowSec, secret)
    return body ? { ok: true, body } : { ok: false, error: 'server_error', description: 'OAuth is not configured.' }
  }
  if (form.grant_type === 'refresh_token') {
    const rt = readToken<{ c: string; sub: string }>(form.refresh_token, 'cqr', nowSec, secret)
    if (!rt || rt.c !== clientTag(clientId)) return { ok: false, error: 'invalid_grant', description: 'The refresh token is invalid or expired.' }
    const body = tokenPair(rt.sub, clientId, nowSec, secret)
    return body ? { ok: true, body } : { ok: false, error: 'server_error', description: 'OAuth is not configured.' }
  }
  return { ok: false, error: 'unsupported_grant_type', description: 'Use authorization_code or refresh_token.' }
}

/** The employee an access token was issued to, or null. */
export function accessTokenSubject(token: string, nowSec: number, secret?: string): string | null {
  const t = readToken<{ sub?: unknown }>(token, 'cqt', nowSec, secret)
  return t && typeof t.sub === 'string' ? t.sub : null
}

export function oauthMetadata(origin: string) {
  return {
    protectedResource: {
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Cirqle',
    },
    authorizationServer: {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPE],
    },
  }
}
