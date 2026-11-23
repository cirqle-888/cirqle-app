import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  AD_BUCKET, MAX_MEDIA, cleanIncomingAd, cleanMedia, cleanTags, extFor, isLibraryId, mediaPath, ownsPath,
} from '@/lib/ad-library/core'
import { keyOwner } from '@/lib/ad-library/server'

export const dynamic = 'force-dynamic'

/**
 * The Cirqle Ad Saver Chrome extension talks to this.
 *
 * Auth: `Authorization: Bearer cas_…`, a personal connect key made in the app
 * (Ad Library → Connect Chrome). Only its hash is stored; a revoked or unknown
 * key gets 401. No Supabase session — the key IS the gate, and every write is
 * stamped with the key owner's employee id.
 *
 *   POST { action: 'ping' }                         → { ok, name }
 *   POST { action: 'folders' }                      → { ok, folders }
 *   POST { action: 'check', ids: [libraryId…] }     → { ok, saved: [libraryId…] }
 *   POST { action: 'prepare', library_id, files: [{ role, n, contentType }] }
 *                                                   → { ok, uploads: [{ role, n, path, url }] }
 *        (the extension PUTs each file straight to its url — files never pass
 *         through this server, so videos are not held back by request limits)
 *   POST { action: 'save', ad, media, avatar?, folder_id?, tags? }
 *                                                   → { ok, id, already }
 *
 * Every answer is { ok: true, … } or { ok: false, error }.
 */

function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get('origin') || ''
  // Only the extension calls this; browsers on other sites get no CORS grant.
  return origin.startsWith('chrome-extension://')
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', Vary: 'Origin' }
    : {}
}

export function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) })
}

const ROLES = ['image', 'video', 'poster', 'avatar'] as const
type Role = typeof ROLES[number]

export async function POST(req: NextRequest) {
  const headers = { ...corsHeaders(req), 'Cache-Control': 'no-store' }
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers })

  let admin
  try { admin = createAdminClient() } catch { return json({ ok: false, error: 'The app is not reachable right now.' }, 503) }

  const owner = await keyOwner(admin, req.headers.get('authorization')).catch(() => null)
  if (!owner) return json({ ok: false, error: 'This connect key is not valid. Make a new one in Cirqle → Ad Library → Connect Chrome.' }, 401)

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ ok: false, error: 'Invalid request.' }, 400) }
  const action = String(body?.action || '')

  try {
    switch (action) {
      case 'ping':
        return json({ ok: true, name: owner.name })

      case 'folders': {
        const { data, error } = await admin.from('ad_folders').select('id, name, sort').is('deleted_at', null).order('sort').order('name')
        if (error) return json({ ok: false, error: 'Ad Library is not set up in the app yet.' }, 503)
        return json({ ok: true, folders: data ?? [] })
      }

      case 'check': {
        const ids = (Array.isArray(body.ids) ? body.ids : []).filter(isLibraryId).slice(0, 200)
        if (!ids.length) return json({ ok: true, saved: [] })
        const { data } = await admin.from('saved_ads').select('library_id').eq('platform', 'facebook').in('library_id', ids).is('deleted_at', null)
        return json({ ok: true, saved: (data ?? []).map(r => r.library_id) })
      }

      case 'prepare': {
        const id = String(body.library_id || '')
        if (!isLibraryId(id)) return json({ ok: false, error: 'That ad has no Library ID.' }, 400)
        const files = (Array.isArray(body.files) ? body.files : []).slice(0, MAX_MEDIA * 2 + 1)
        const uploads: { role: Role; n: number; path: string; url: string }[] = []
        for (const f of files as Record<string, unknown>[]) {
          const role = ROLES.includes(f?.role as Role) ? (f.role as Role) : null
          const n = Number(f?.n)
          if (!role || !Number.isInteger(n) || n < 0 || n >= MAX_MEDIA) continue
          const path = mediaPath(id, n, role, extFor(f.contentType, role === 'video' ? 'video' : 'image'))
          const { data, error } = await admin.storage.from(AD_BUCKET).createSignedUploadUrl(path, { upsert: true })
          if (error || !data) return json({ ok: false, error: 'Could not get a place to store the pictures.' }, 500)
          uploads.push({ role, n, path, url: data.signedUrl })
        }
        return json({ ok: true, uploads })
      }

      case 'save': {
        const ad = cleanIncomingAd(body.ad)
        if (!ad) return json({ ok: false, error: 'That ad has no Library ID.' }, 400)
        const media = cleanMedia(ad.library_id, body.media)
        const avatar = ownsPath(ad.library_id, body.avatar) ? body.avatar : null
        const folderId = typeof body.folder_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.folder_id) ? body.folder_id : null
        const tags = cleanTags(body.tags)

        const { data: existing } = await admin.from('saved_ads')
          .select('id, deleted_at, media, page_avatar').eq('platform', 'facebook').eq('library_id', ad.library_id).maybeSingle()

        const now = new Date().toISOString()
        if (existing) {
          // Saved before: refresh what Facebook shows, keep the team's folder, client, tags and notes.
          const patch: Record<string, unknown> = { ...ad, updated_at: now, deleted_at: null }
          if (media.length) patch.media = media
          if (avatar) patch.page_avatar = avatar
          if (existing.deleted_at) { patch.saved_by = owner.employeeId; patch.created_at = now; if (folderId) patch.folder_id = folderId; if (tags.length) patch.tags = tags }
          const { error } = await admin.from('saved_ads').update(patch).eq('id', existing.id)
          if (error) return json({ ok: false, error: 'Could not save the ad.' }, 500)
          return json({ ok: true, id: existing.id, already: !existing.deleted_at })
        }

        const { data, error } = await admin.from('saved_ads').insert({
          ...ad, platform: 'facebook', media, page_avatar: avatar, folder_id: folderId, tags, saved_by: owner.employeeId,
        }).select('id').single()
        if (error || !data) return json({ ok: false, error: error?.code === '42P01' ? 'Ad Library is not set up in the app yet.' : 'Could not save the ad.' }, 500)
        return json({ ok: true, id: data.id, already: false })
      }

      default:
        return json({ ok: false, error: `Unknown action "${action}".` }, 400)
    }
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : 'Server error.' }, 500)
  }
}
