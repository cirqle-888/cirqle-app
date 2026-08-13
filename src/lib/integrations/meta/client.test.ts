import { describe, it, expect, beforeEach } from 'vitest'
import { redactTokens, appSecretProof, MetaApiError, META_API_VERSION } from './client'
import { createHmac } from 'crypto'

describe('META_API_VERSION', () => {
  it('is pinned to a modern Graph version (not the sunset v19)', () => {
    expect(META_API_VERSION).not.toBe('v19.0')
    expect(META_API_VERSION).toMatch(/^v\d+\.0$/)
  })
})

describe('redactTokens', () => {
  it('removes access_token query params', () => {
    expect(redactTokens('GET /me?access_token=EAABxyz123&fields=id')).toContain('access_token=REDACTED')
  })
  it('redacts bare EAA tokens', () => {
    expect(redactTokens('token is EAABnevershowthis')).not.toContain('EAABnevershowthis')
  })
  it('handles null/undefined', () => {
    expect(redactTokens(null)).toBe('')
    expect(redactTokens(undefined)).toBe('')
  })
})

describe('appSecretProof', () => {
  beforeEach(() => {
    process.env.META_APP_ID = 'app123'
    process.env.META_APP_SECRET = 'secret123'
  })
  it('returns the HMAC-SHA256 hex of the token with the app secret', () => {
    const token = 'the-access-token'
    const expected = createHmac('sha256', 'secret123').update(token).digest('hex')
    expect(appSecretProof(token)).toBe(expected)
  })
  it('returns null when creds are missing', () => {
    delete process.env.META_APP_ID
    delete process.env.META_CLIENT_ID
    delete process.env.META_APP_SECRET
    delete process.env.META_CLIENT_SECRET
    expect(appSecretProof('t')).toBeNull()
  })
})

describe('MetaApiError classification', () => {
  it('marks code 190 as an auth error', () => {
    const e = new MetaApiError(400, { error: { code: 190, message: 'expired' } })
    expect(e.isAuthError).toBe(true)
    expect(e.isRateLimit).toBe(false)
  })
  it('marks code 4 as rate limit', () => {
    const e = new MetaApiError(400, { error: { code: 4, message: 'too many' } })
    expect(e.isRateLimit).toBe(true)
  })
  it('marks a 2xx permission code as auth error', () => {
    const e = new MetaApiError(403, { error: { code: 200, message: 'perm' } })
    expect(e.isAuthError).toBe(true)
  })
  it('a plain 100 error is neither auth nor rate limit', () => {
    const e = new MetaApiError(400, { error: { code: 100, message: 'bad param' } })
    expect(e.isAuthError).toBe(false)
    expect(e.isRateLimit).toBe(false)
  })
  it('prefers error_user_msg over message', () => {
    const e = new MetaApiError(400, { error: { code: 100, message: 'raw', error_user_msg: 'friendly' } })
    expect(e.message).toBe('friendly')
  })
})
