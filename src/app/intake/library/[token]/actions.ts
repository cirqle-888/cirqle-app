'use server'

/**
 * Product Library intake — a client-facing, token-gated app where a shop owner
 * adds the vegetables and fruits they sell (name, local name, photo) into the
 * global Product Catalog.
 *
 * Trust model mirrors the offer intake (src/app/intake/offer/[token]/actions.ts):
 * the unguessable token IS the auth — no employee session, admin client only,
 * every action re-resolves the token rather than trusting anything the browser
 * sends. Submissions land as review_status='pending' and are invisible to the
 * catalog until staff approve them.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { selectWithOptionalColumns } from '@/lib/offer-columns'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

/** The two things this app collects. Not exported: a 'use server' module may
 *  only export async functions, and the value is duplicated (deliberately, and
 *  only here) in library-client.tsx for the picker. Server-side validation is
 *  the authority — a hand-crafted POST can't push arbitrary category strings
 *  into the shared catalog. */
const LIBRARY_CATEGORIES: readonly string[] = ['Vegetables', 'Fruits']

export interface LibraryItem {
  id: string
  name: string
  local_name: string | null
  category: string | null
  review_status: string
  image_url: string | null
  created_at: string | null
}

const MAX_NAME = 120

// ── Token resolution ──────────────────────────────────────────────────────────

/**
 * Resolve clients.product_library_token. Mirrors resolveOfferToken: short
 * tokens are rejected outright (a 3-character token is a typo or a probe, not a
 * capability URL) and only active clients resolve.
 *
 * Note the filter column itself ships with migration 20260719140000 — before
 * that migration is applied every lookup errors and this returns null, so the
 * page renders its "link unavailable" state instead of throwing.
 */
async function resolveLibraryToken(token: string) {
  if (!token || token.length < 16) return null
  try {
    const admin = createAdminClient()
    const { data } = await admin
      .from('clients')
      .select('id, name, product_library_token')
      .eq('product_library_token', token)
      .eq('is_active', true)
      .maybeSingle()
    return (data as { id: string; name: string } | null) || null
  } catch { return null }
}

/** Case-insensitive exact match on a client-supplied name. `%` and `_` are
 *  legal characters in a product name but wildcards to ilike, so they're
 *  escaped — otherwise "50% Off" would match unrelated rows. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, c => `\\${c}`)
}

function localNameOf(names: unknown): string | null {
  if (!names || typeof names !== 'object') return null
  const ml = (names as Record<string, unknown>).ml
  return typeof ml === 'string' && ml.trim() ? ml.trim() : null
}

// ── Page data ─────────────────────────────────────────────────────────────────

export async function getLibraryPageData(token: string): Promise<ActionResult<{
  client: { id: string; name: string }
  items: LibraryItem[]
  logoUrl: string | null
}>> {
  const client = await resolveLibraryToken(token)
  if (!client) return { ok: false, error: 'This link is no longer valid.' }

  const admin = createAdminClient()

  const [rows, logoRes, logoDarkRes] = await Promise.all([
    // review_status / names / submitted_at only exist post-migration; ask for
    // them, quietly retry without them so a code deploy that lands first
    // degrades to a plain list rather than an empty one.
    selectWithOptionalColumns<any[]>(
      'id, name, category, image_url, created_at',
      ['review_status', 'names', 'submitted_at'],
      cols => admin
        .from('product_catalog')
        .select(cols)
        .eq('submitted_by_client_id', client.id)
        .order('created_at', { ascending: false })
        .limit(100),
    ),
    admin.from('company_settings').select('value').eq('key', 'logo_url').maybeSingle(),
    admin.from('company_settings').select('value').eq('key', 'logo_url_dark').maybeSingle(),
  ])

  const items: LibraryItem[] = (rows || []).map((r: any) => ({
    id: r.id,
    name: r.name,
    local_name: localNameOf(r.names),
    category: r.category ?? null,
    review_status: r.review_status || 'pending',
    image_url: r.image_url ?? null,
    created_at: r.created_at ?? null,
  }))

  return {
    ok: true,
    data: {
      client: { id: client.id, name: client.name },
      items,
      logoUrl: (logoDarkRes.data?.value as string) || (logoRes.data?.value as string) || null,
    },
  }
}

// ── Submit ────────────────────────────────────────────────────────────────────

export interface LibraryProductInput {
  name: string
  localName?: string
  category: string
  imageUrl?: string
}

export async function submitLibraryProduct(
  token: string,
  input: LibraryProductInput,
): Promise<ActionResult<{ id: string }>> {
  const client = await resolveLibraryToken(token)
  if (!client) return { ok: false, error: 'This link is no longer valid.' }

  const name = (input.name || '').trim().replace(/\s+/g, ' ')
  if (!name) return { ok: false, error: 'Please type the name of the product.' }
  if (name.length > MAX_NAME) return { ok: false, error: `That name is too long — please keep it under ${MAX_NAME} characters.` }

  const localName = (input.localName || '').trim().slice(0, MAX_NAME)

  const category = (input.category || '').trim()
  if (!LIBRARY_CATEGORIES.includes(category)) {
    return { ok: false, error: 'Please choose whether this is a vegetable or a fruit.' }
  }

  // The photo URL is whatever the browser got back from getLibraryImageUploadUrl,
  // so it's still an untrusted string by the time it lands here. It ends up in an
  // <img src>, and `javascript:` / `data:` URLs there are a stored-XSS vector.
  const imageUrl = (input.imageUrl || '').trim()
  if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
    return { ok: false, error: 'That photo could not be attached. Please upload it again.' }
  }

  const admin = createAdminClient()

  // Does this product already exist under that name? One case-insensitive
  // lookup answers both duplicate questions below.
  const existing = await selectWithOptionalColumns<any[]>(
    'id, name',
    ['review_status', 'submitted_by_client_id'],
    cols => admin
      .from('product_catalog')
      .select(cols)
      .ilike('name', escapeLike(name))
      .limit(20),
  )

  for (const row of existing || []) {
    // Rows predating the migration have no review_status; the column defaults
    // to 'approved', so treat a missing value the same way.
    const status = row.review_status || 'approved'
    if (status === 'pending' && row.submitted_by_client_id === client.id) {
      return { ok: false, error: `You have already sent us "${row.name}" — it is waiting to be checked.` }
    }
  }
  const approved = (existing || []).find((r: any) => (r.review_status || 'approved') === 'approved')
  if (approved) {
    return { ok: false, error: `Good news — "${approved.name}" is already in the library, so there is no need to add it again.` }
  }

  // Write path: deliberately NOT column-tolerant. A save that silently dropped
  // review_status would publish an unreviewed product into the live catalog.
  const { data: created, error } = await admin
    .from('product_catalog')
    .insert({
      name,
      category,
      names: localName ? { ml: localName } : {},
      review_status: 'pending',
      submitted_by_client_id: client.id,
      submitted_at: new Date().toISOString(),
      status: 'active',
      image_url: imageUrl || null,
    })
    .select('id')
    .single()

  if (error || !created) {
    return { ok: false, error: 'Could not save that product. Please try again, or contact Cirqle.' }
  }

  if (imageUrl) {
    // One row per treatment (UNIQUE(product_id, version)); this product was just
    // created, so 'original' is always free.
    const { error: imgError } = await admin.from('product_catalog_images').insert({
      product_id: created.id,
      version: 'original',
      url: imageUrl,
      source: 'upload',
      is_primary: true,
    })
    // The photo is already on product_catalog.image_url above, so a failure here
    // costs the image-history row, not the submission — don't fail the save.
    if (imgError) {
      console.error('[library-intake] could not record product image', imgError)
    }
  }

  return { ok: true, data: { id: created.id as string } }
}

// ── Upload product photo ──────────────────────────────────────────────────────

export async function getLibraryImageUploadUrl(
  token: string,
  filename: string,
  contentType: string,
): Promise<ActionResult<{ uploadUrl: string; publicUrl: string; path: string }>> {
  const client = await resolveLibraryToken(token)
  if (!client) return { ok: false, error: 'Invalid link.' }

  // The bucket is public, so both the declared type and the extension are
  // attacker-controlled inputs that decide how a browser renders whatever gets
  // uploaded. Allow only real image types, and derive the extension from the
  // type rather than from the supplied filename — a "photo.html" or
  // "photo.svg" served from our own origin is a stored-XSS vector, not a photo.
  const EXT_BY_TYPE: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    // iPhone photos routinely arrive as HEIC/HEIF rather than JPEG.
    'image/heic': 'heic',
    'image/heif': 'heif',
  }
  const ALLOWED_EXTS = new Set(Object.values(EXT_BY_TYPE).concat('jpeg'))

  // Browsers occasionally hand over a File with an empty type (some Android
  // pickers, some drag-and-drop sources), so fall back to the filename
  // extension — but only when it is one we recognise.
  const declaredType = contentType.toLowerCase().split(';')[0].trim()
  const filenameExt = (filename.split('.').pop() || '').toLowerCase()
  const ext = EXT_BY_TYPE[declaredType] ?? (ALLOWED_EXTS.has(filenameExt) ? filenameExt : undefined)
  if (!ext) {
    return { ok: false, error: 'Only JPG, PNG, WebP, GIF, AVIF or HEIC images can be uploaded.' }
  }
  const path = `${client.id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

  const admin = createAdminClient()
  const { data, error } = await admin.storage
    .from('product-images')
    .createSignedUploadUrl(path)

  if (error || !data) return { ok: false, error: 'Could not prepare upload.' }

  const { data: pub } = admin.storage.from('product-images').getPublicUrl(path)

  return {
    ok: true,
    data: {
      uploadUrl: data.signedUrl,
      publicUrl: pub.publicUrl,
      path,
    },
  }
}
