import 'server-only'
import { createHash, randomBytes } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AD_BUCKET, readMedia, type SavedAd } from './core'

/**
 * Server-only Ad Library helpers: who owns a connect key, and short-lived
 * links to the copied pictures and videos (the bucket is private).
 */

/** Today's date in India, as YYYY-MM-DD. */
export function todayInIndia(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
}

// ── connect keys ─────────────────────────────────────────────────────────────

export function newConnectKey(): string {
  return 'cas_' + randomBytes(24).toString('base64url')
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key.trim()).digest('hex')
}

export function looksLikeKey(v: unknown): v is string {
  return typeof v === 'string' && /^cas_[A-Za-z0-9_-]{30,40}$/.test(v.trim())
}

export interface KeyOwner { keyId: string; employeeId: string; name: string }

/** The person a bearer connect key belongs to, or null. Marks the key as used. */
export async function keyOwner(admin: SupabaseClient, authHeader: string | null): Promise<KeyOwner | null> {
  const key = (authHeader || '').replace(/^Bearer\s+/i, '').trim()
  if (!looksLikeKey(key)) return null
  const { data } = await admin
    .from('ad_saver_keys')
    .select('id, employee_id, revoked_at')
    .eq('key_hash', hashKey(key))
    .maybeSingle()
  if (!data || data.revoked_at) return null
  const { data: emp } = await admin.from('employees').select('name').eq('id', data.employee_id).maybeSingle()
  await admin.from('ad_saver_keys').update({ last_used_at: new Date().toISOString() }).eq('id', data.id)
  return { keyId: data.id as string, employeeId: data.employee_id as string, name: (emp?.name as string) || 'Cirqle' }
}

/** path → signed link (1 hour) for every picture, video, poster and page photo of these ads. */
export async function signedMediaLinks(admin: SupabaseClient, ads: SavedAd[]): Promise<Record<string, string>> {
  const paths = new Set<string>()
  for (const a of ads) {
    if (a.page_avatar) paths.add(a.page_avatar)
    for (const m of readMedia(a.media)) { paths.add(m.path); if (m.poster) paths.add(m.poster) }
  }
  const list = [...paths]
  const out: Record<string, string> = {}
  for (let i = 0; i < list.length; i += 200) {
    const { data } = await admin.storage.from(AD_BUCKET).createSignedUrls(list.slice(i, i + 200), 3600)
    for (const d of data ?? []) if (d.path && d.signedUrl) out[d.path] = d.signedUrl
  }
  return out
}
