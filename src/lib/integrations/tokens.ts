/**
 * At-rest encryption for provider OAuth tokens (AES-256-GCM).
 *
 * Why: provider_connections / social_accounts hold Meta access tokens. They must
 * never sit in the database as plaintext (see docs/db-state.md — the table was
 * readable with the public anon key in production).
 *
 * Key: META_TOKEN_ENCRYPTION_KEY env var. Accepts base64 or hex for a 32-byte
 * key; any other string is sha256-derived. Falls back to a key derived from
 * SUPABASE_SERVICE_ROLE_KEY so encryption is always on, but set a dedicated
 * key in production so DB credentials and crypto keys rotate independently.
 *
 * Format: `enc:v1:<base64(iv)>:<base64(ciphertext)>:<base64(authTag)>`.
 * decryptToken() passes through values without the prefix so existing plaintext
 * rows keep working; they are re-encrypted the next time they are written.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'

const PREFIX = 'enc:v1:'

function encryptionKey(): Buffer {
  const raw = process.env.META_TOKEN_ENCRYPTION_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!raw) throw new Error('META_TOKEN_ENCRYPTION_KEY (or SUPABASE_SERVICE_ROLE_KEY) must be set to encrypt provider tokens')
  // 32-byte base64?
  try {
    const b = Buffer.from(raw, 'base64')
    if (b.length === 32) return b
  } catch { /* fall through */ }
  // 32-byte hex?
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
  // Derive
  return createHash('sha256').update(raw).digest()
}

export function isEncryptedToken(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

export function encryptToken(plaintext: string | null | undefined): string | null {
  if (!plaintext) return null
  if (isEncryptedToken(plaintext)) return plaintext
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString('base64')}:${ciphertext.toString('base64')}:${tag.toString('base64')}`
}

/**
 * Decrypt a stored token. Plaintext (legacy, un-prefixed) values are returned
 * as-is so the migration to encrypted storage is zero-downtime.
 */
export function decryptToken(stored: string | null | undefined): string | null {
  if (!stored) return null
  if (!isEncryptedToken(stored)) return stored
  const parts = stored.slice(PREFIX.length).split(':')
  if (parts.length !== 3) throw new Error('Malformed encrypted token')
  const [ivB64, dataB64, tagB64] = parts
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()])
  return plain.toString('utf8')
}
