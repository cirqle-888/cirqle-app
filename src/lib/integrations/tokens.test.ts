import { describe, it, expect, beforeEach } from 'vitest'

// Env must be set before importing the module (key is read at call time, so
// setting per-test is fine, but keep it explicit).
beforeEach(() => {
  process.env.META_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64) // 32-byte hex
})

async function load() {
  return await import('./tokens')
}

describe('tokens: encrypt/decrypt', () => {
  it('round-trips a value', async () => {
    const { encryptToken, decryptToken, isEncryptedToken } = await load()
    const enc = encryptToken('EAABsecret-token')!
    expect(isEncryptedToken(enc)).toBe(true)
    expect(enc).not.toContain('EAABsecret-token')
    expect(decryptToken(enc)).toBe('EAABsecret-token')
  })

  it('produces different ciphertext each time (random IV) but both decrypt', async () => {
    const { encryptToken, decryptToken } = await load()
    const a = encryptToken('same-token')!
    const b = encryptToken('same-token')!
    expect(a).not.toBe(b)
    expect(decryptToken(a)).toBe('same-token')
    expect(decryptToken(b)).toBe('same-token')
  })

  it('passes legacy plaintext through unchanged', async () => {
    const { decryptToken, isEncryptedToken } = await load()
    expect(isEncryptedToken('plain-legacy-token')).toBe(false)
    expect(decryptToken('plain-legacy-token')).toBe('plain-legacy-token')
  })

  it('is a no-op when re-encrypting an already-encrypted value', async () => {
    const { encryptToken } = await load()
    const enc = encryptToken('tok')!
    expect(encryptToken(enc)).toBe(enc)
  })

  it('handles null / empty', async () => {
    const { encryptToken, decryptToken } = await load()
    expect(encryptToken(null)).toBeNull()
    expect(encryptToken('')).toBeNull()
    expect(decryptToken(null)).toBeNull()
    expect(decryptToken(undefined)).toBeNull()
  })

  it('throws on a malformed encrypted value', async () => {
    const { decryptToken } = await load()
    expect(() => decryptToken('enc:v1:onlytwo:parts')).toThrow()
  })

  it('throws on tampered ciphertext (GCM auth)', async () => {
    const { encryptToken, decryptToken } = await load()
    const enc = encryptToken('tok')!
    const parts = enc.slice('enc:v1:'.length).split(':')
    // Flip a character in the data segment.
    const data = parts[1]
    const tampered = `enc:v1:${parts[0]}:${data[0] === 'A' ? 'B' : 'A'}${data.slice(1)}:${parts[2]}`
    expect(() => decryptToken(tampered)).toThrow()
  })

  it('accepts a passphrase key (sha256-derived)', async () => {
    process.env.META_TOKEN_ENCRYPTION_KEY = 'just-a-passphrase'
    const { encryptToken, decryptToken } = await load()
    const enc = encryptToken('x')!
    expect(decryptToken(enc)).toBe('x')
  })
})
