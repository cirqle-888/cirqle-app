import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import {
  accessTokenSubject, checkAuthorize, clientInfo, exchange, issueCode, pkceMatches, readToken, registerClient,
  sameRedirect, signToken, validRedirectUri, ACCESS_TTL, CODE_TTL,
} from './oauth'

const S = 'test-secret'
const NOW = 1_800_000_000
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback'
const verifier = 'v'.repeat(43) + 'abc'
const challenge = createHash('sha256').update(verifier).digest('base64url')

function register(uris: string[] = [CLAUDE]) {
  const r = registerClient({ redirect_uris: uris, client_name: 'Claude' }, NOW, S)
  if (!r.ok) throw new Error(r.error)
  return r.clientId
}

describe('signed tokens', () => {
  it('round-trip, and refuse tampering, other kinds, other keys and expiry', () => {
    const t = signToken('cqt', { sub: 'e1', exp: NOW + 10 }, S)!
    expect(readToken(t, 'cqt', NOW, S)).toMatchObject({ sub: 'e1' })
    expect(readToken(t, 'cqr', NOW, S)).toBeNull()
    expect(readToken(t, 'cqt', NOW, 'other')).toBeNull()
    expect(readToken(t, 'cqt', NOW + 11, S)).toBeNull()
    const [k, body, sig] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', exp: NOW + 10 })).toString('base64url')
    expect(readToken(`${k}.${forged}.${sig}`, 'cqt', NOW, S)).toBeNull()
    expect(readToken(`${k}.${body}`, 'cqt', NOW, S)).toBeNull()
  })
  it('need MCP_API_TOKEN to exist', () => {
    expect(signToken('cqt', { sub: 'e1' }, '')).toBeNull()
    expect(readToken('cqt.a.b', 'cqt', NOW, '')).toBeNull()
  })
})

describe('client registration', () => {
  it('accepts https and loopback redirects only', () => {
    expect(validRedirectUri(CLAUDE)).toBe(true)
    expect(validRedirectUri('http://localhost:3118/callback')).toBe(true)
    expect(validRedirectUri('http://evil.com/cb')).toBe(false)
    expect(validRedirectUri('javascript:alert(1)')).toBe(false)
    expect(registerClient({ redirect_uris: ['http://evil.com/cb'] }, NOW, S)).toMatchObject({ ok: false, error: 'invalid_redirect_uri' })
    expect(clientInfo(register(), NOW, S)).toMatchObject({ r: [CLAUDE], n: 'Claude' })
  })
  it('matches loopback redirects on any port', () => {
    expect(sameRedirect('http://localhost/callback', 'http://127.0.0.1:5123/callback')).toBe(true)
    expect(sameRedirect(CLAUDE, `${CLAUDE}x`)).toBe(false)
  })
})

describe('authorize', () => {
  const base = (clientId: string) => ({ client_id: clientId, redirect_uri: CLAUDE, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 's' })
  it('accepts a registered client with PKCE', () => {
    expect(checkAuthorize(base(register()), NOW, S)).toMatchObject({ ok: true })
  })
  it('never redirects errors to an unproven address', () => {
    expect(checkAuthorize({ ...base(register()), redirect_uri: 'https://evil.com/cb' }, NOW, S)).toMatchObject({ ok: false, redirectOk: false })
    expect(checkAuthorize({ ...base('cqc.fake.sig') }, NOW, S)).toMatchObject({ ok: false, redirectOk: false, error: 'invalid_client' })
  })
  it('requires S256 PKCE and the code flow', () => {
    expect(checkAuthorize({ ...base(register()), code_challenge_method: 'plain' }, NOW, S)).toMatchObject({ ok: false, redirectOk: true })
    expect(checkAuthorize({ ...base(register()), response_type: 'token' }, NOW, S)).toMatchObject({ ok: false, error: 'unsupported_response_type' })
  })
})

describe('token exchange', () => {
  it('swaps a code for tokens once PKCE matches, then refreshes', () => {
    const clientId = register()
    const code = issueCode({ clientId, redirectUri: CLAUDE, challenge, sub: 'emp-1' }, NOW, S)!
    const form = { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CLAUDE, code_verifier: verifier }
    const r = exchange(form, NOW + 5, S)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.body).toMatchObject({ token_type: 'Bearer', expires_in: ACCESS_TTL, scope: 'cirqle' })
    expect(accessTokenSubject(r.body.access_token, NOW + 10, S)).toBe('emp-1')
    expect(accessTokenSubject(r.body.refresh_token, NOW + 10, S)).toBeNull()
    const again = exchange({ grant_type: 'refresh_token', refresh_token: r.body.refresh_token, client_id: clientId }, NOW + ACCESS_TTL + 5, S)
    expect(again.ok && accessTokenSubject(again.body.access_token, NOW + ACCESS_TTL + 6, S)).toBe('emp-1')
  })
  it('refuses a wrong verifier, another client, another redirect or an old code', () => {
    const clientId = register()
    const other = register(['https://chatgpt.com/connector_platform_oauth_redirect'])
    const code = issueCode({ clientId, redirectUri: CLAUDE, challenge, sub: 'emp-1' }, NOW, S)!
    const form = { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CLAUDE, code_verifier: verifier }
    expect(exchange({ ...form, code_verifier: 'w'.repeat(50) }, NOW, S)).toMatchObject({ ok: false, error: 'invalid_grant' })
    expect(exchange({ ...form, client_id: other }, NOW, S)).toMatchObject({ ok: false, error: 'invalid_grant' })
    expect(exchange({ ...form, redirect_uri: 'https://claude.ai/other' }, NOW, S)).toMatchObject({ ok: false, error: 'invalid_grant' })
    expect(exchange(form, NOW + CODE_TTL + 1, S)).toMatchObject({ ok: false, error: 'invalid_grant' })
    expect(exchange({ ...form, grant_type: 'password' }, NOW, S)).toMatchObject({ ok: false, error: 'unsupported_grant_type' })
  })
  it('checks PKCE verifier format', () => {
    expect(pkceMatches(verifier, challenge)).toBe(true)
    expect(pkceMatches('short', challenge)).toBe(false)
  })
})
