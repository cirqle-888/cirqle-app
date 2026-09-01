'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission, requireReadPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { selectWithOptionalColumns } from '@/lib/offer-columns'
import { revalidatePath } from 'next/cache'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProductRow {
  name: string
  weight?: string
  category?: string
  brand?: string
  barcode?: string
  image_url?: string
  notes?: string
}

// ── List products ─────────────────────────────────────────────────────────────

export async function getProducts(filters?: {
  search?: string
  category?: string
  brand?: string
  status?: string
}): Promise<ActionResult<{ products: any[] }>> {
  const guard = await requireReadPermission(PERMS.OFFER_PREPARE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const empId = guard.employeeId

  const admin = createAdminClient()

  const build = (extraSelect: string) => {
    let q = admin
      .from('product_catalog')
      .select(`
        id, product_code, name, weight, category, brand, barcode,
        image_url, status, notes, created_at, updated_at${extraSelect},
        images:product_catalog_images(id, version, url, is_primary, created_at),
        assignments:client_product_assignments(client_id, is_active)
      `)
      .order('name')

    if (filters?.status && filters.status !== 'all') q = q.eq('status', filters.status)
    if (filters?.category) q = q.eq('category', filters.category)
    if (filters?.brand) q = q.eq('brand', filters.brand)
    // Escape LIKE wildcards: a product search for "50% off" must not turn % into
    // a wildcard and match everything.
    if (filters?.search) q = q.ilike('name', `%${filters.search.replace(/[\\%_]/g, c => `\\${c}`)}%`)
    return q
  }

  // Products a client submitted are invisible here until staff approve them —
  // otherwise an unreviewed row sits in the grid looking exactly like a curated
  // one and can be pushed to clients before anyone has checked it. Rejected
  // rows stay hidden for good.
  //
  // Tolerates the pre-migration schema: if review_status does not exist yet the
  // filtered query 42703s, and we fall back to the unfiltered list rather than
  // blanking the entire catalog.
  const filtered = await build(', names, review_status').eq('review_status', 'approved')
  if (!filtered.error) return { ok: true, data: { products: filtered.data || [] } }
  if (filtered.error.code !== '42703') return { ok: false, error: filtered.error.message }

  const { data, error } = await build('')
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { products: data || [] } }
}

// ── Create single product ────────────────────────────────────────────────────

export async function createProduct(row: ProductRow): Promise<ActionResult<{ product: any }>> {
  const guard = await requirePermission(PERMS.OFFER_PREPARE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const empId = guard.employeeId

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('product_catalog')
    .insert({
      name: row.name.trim(),
      weight: row.weight?.trim() || null,
      category: row.category?.trim() || null,
      brand: row.brand?.trim() || null,
      barcode: row.barcode?.trim() || null,
      image_url: row.image_url?.trim() || null,
      notes: row.notes?.trim() || null,
    })
    .select()
    .single()

  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/catalog')
  return { ok: true, data: { product: data } }
}

// ── Update product ────────────────────────────────────────────────────────────

export async function updateProduct(
  id: string,
  row: Partial<ProductRow> & { status?: string },
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.OFFER_PREPARE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const empId = guard.employeeId

  const admin = createAdminClient()
  const updates: Record<string, any> = { updated_at: new Date().toISOString() }
  if (row.name !== undefined)      updates.name = row.name.trim()
  if (row.weight !== undefined)    updates.weight = row.weight?.trim() || null
  if (row.category !== undefined)  updates.category = row.category?.trim() || null
  if (row.brand !== undefined)     updates.brand = row.brand?.trim() || null
  if (row.barcode !== undefined)   updates.barcode = row.barcode?.trim() || null
  if (row.image_url !== undefined) updates.image_url = row.image_url?.trim() || null
  if (row.notes !== undefined)     updates.notes = row.notes?.trim() || null
  if (row.status !== undefined)    updates.status = row.status

  const { error } = await admin.from('product_catalog').update(updates).eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/catalog')
  return { ok: true }
}

// ── Bulk import products ─────────────────────────────────────────────────────

export async function bulkImportProducts(
  rows: ProductRow[],
): Promise<ActionResult<{ inserted: number; skipped: number; errors: string[] }>> {
  const guard = await requirePermission(PERMS.OFFER_PREPARE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const empId = guard.employeeId
  if (!rows.length) return { ok: false, error: 'No rows to import.' }

  const admin = createAdminClient()
  let inserted = 0, skipped = 0
  const errors: string[] = []

  // Process in batches of 50
  const chunks = Array.from({ length: Math.ceil(rows.length / 50) }, (_, i) => rows.slice(i * 50, i * 50 + 50))

  for (const chunk of chunks) {
    const toInsert = chunk
      .filter(r => r.name?.trim())
      .map(r => ({
        name: r.name.trim(),
        weight: r.weight?.trim() || null,
        category: r.category?.trim() || null,
        brand: r.brand?.trim() || null,
        barcode: r.barcode?.trim() || null,
        image_url: r.image_url?.trim() || null,
        notes: r.notes?.trim() || null,
      }))

    skipped += chunk.length - toInsert.length

    if (!toInsert.length) continue

    const { error, count } = await admin
      .from('product_catalog')
      .insert(toInsert, { count: 'exact' })

    if (error) {
      errors.push(error.message)
    } else {
      inserted += count || toInsert.length
    }
  }

  revalidatePath('/dashboard/catalog')
  return { ok: errors.length === 0, data: { inserted, skipped, errors } }
}

// ── Get signed upload URL for product image ──────────────────────────────────

export async function getProductImageUploadUrl(
  productId: string,
  filename: string,
  contentType: string,
): Promise<ActionResult<{ uploadUrl: string; publicUrl: string; storagePath: string }>> {
  const guard = await requirePermission(PERMS.OFFER_PREPARE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const empId = guard.employeeId

  const admin = createAdminClient()

  const EXT_BY_TYPE: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
    'image/heic': 'heic', 'image/heif': 'heif',
  }
  const ALLOWED_EXTS = new Set([...Object.values(EXT_BY_TYPE), 'jpeg'])
  const declaredType = contentType.toLowerCase().split(';')[0].trim()
  const filenameExt = (filename.split('.').pop() || '').toLowerCase()
  const ext = EXT_BY_TYPE[declaredType] ?? (ALLOWED_EXTS.has(filenameExt) ? filenameExt : undefined)
  
  if (!ext) {
    return { ok: false, error: 'Only JPG, PNG, WebP, GIF, AVIF or HEIC images can be uploaded.' }
  }

  const storagePath = `catalog/${productId}/${Date.now()}-original.${ext}`

  const { data, error } = await admin.storage
    .from('product-images')
    .createSignedUploadUrl(storagePath)

  if (error || !data) return { ok: false, error: error?.message || 'Could not create upload URL' }

  const { data: { publicUrl } } = admin.storage
    .from('product-images')
    .getPublicUrl(storagePath)

  return { ok: true, data: { uploadUrl: data.signedUrl, publicUrl, storagePath } }
}

// ── Save image record after upload ───────────────────────────────────────────

export async function saveProductImage(
  productId: string,
  url: string,
  storagePath: string,
  version: 'original' | 'bg_removed' | 'flyer_ready' | 'thumbnail' = 'original',
  makePrimary = true,
): Promise<ActionResult<{ imageId: string }>> {
  const guard = await requirePermission(PERMS.OFFER_PREPARE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const empId = guard.employeeId

  const admin = createAdminClient()

  // If making primary, unset existing primary
  if (makePrimary) {
    await admin.from('product_catalog_images')
      .update({ is_primary: false })
      .eq('product_id', productId)
      .eq('is_primary', true)
  }

  const { data, error } = await admin.from('product_catalog_images')
    .insert({ product_id: productId, version, url, storage_path: storagePath, is_primary: makePrimary, source: 'upload' })
    .select('id')
    .single()

  if (error) return { ok: false, error: error.message }

  // Update product.image_url shortcut if primary
  if (makePrimary) {
    await admin.from('product_catalog').update({ image_url: url }).eq('id', productId)
  }

  revalidatePath('/dashboard/catalog')
  return { ok: true, data: { imageId: data.id } }
}

// ── Set an existing image as primary ─────────────────────────────────────────

export async function setPrimaryImage(productId: string, imageId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.OFFER_PREPARE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const empId = guard.employeeId

  const admin = createAdminClient()
  await admin.from('product_catalog_images').update({ is_primary: false }).eq('product_id', productId).eq('is_primary', true)
  const { data, error } = await admin.from('product_catalog_images')
    .update({ is_primary: true }).eq('id', imageId).select('url').single()
  if (error || !data) return { ok: false, error: error?.message || 'Image not found.' }

  await admin.from('product_catalog').update({ image_url: data.url }).eq('id', productId)
  revalidatePath('/dashboard/catalog')
  return { ok: true }
}

// ── Delete an image (manual cleanup — separate from the scheduled retention job) ──

export async function deleteProductImage(imageId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.OFFER_PREPARE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const empId = guard.employeeId

  const admin = createAdminClient()
  const { data: img } = await admin.from('product_catalog_images').select('storage_path, product_id, is_primary').eq('id', imageId).maybeSingle()
  if (!img) return { ok: false, error: 'Image not found.' }

  if (img.storage_path) await admin.storage.from('product-images').remove([img.storage_path])
  await admin.from('product_catalog_images').delete().eq('id', imageId)

  // If the deleted image was primary, promote the next-newest remaining image.
  if (img.is_primary) {
    const { data: next } = await admin.from('product_catalog_images')
      .select('id, url').eq('product_id', img.product_id).order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (next) {
      await admin.from('product_catalog_images').update({ is_primary: true }).eq('id', next.id)
      await admin.from('product_catalog').update({ image_url: next.url }).eq('id', img.product_id)
    } else {
      await admin.from('product_catalog').update({ image_url: null }).eq('id', img.product_id)
    }
  }

  revalidatePath('/dashboard/catalog')
  return { ok: true }
}

// ── Assign / unassign product to clients ────────────────────────────────────

export async function assignProductToClients(
  productId: string,
  clientIds: string[],
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.OFFER_PREPARE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const empId = guard.employeeId

  const admin = createAdminClient()

  // Upsert assignments for selected clients
  if (clientIds.length > 0) {
    const rows = clientIds.map(client_id => ({
      client_id, product_id: productId, is_active: true,
    }))
    const { error } = await admin
      .from('client_product_assignments')
      .upsert(rows, { onConflict: 'client_id,product_id' })
    if (error) return { ok: false, error: error.message }
  }

  revalidatePath('/dashboard/catalog')
  return { ok: true }
}

// ── Remove client assignment ─────────────────────────────────────────────────

export async function removeClientAssignment(
  productId: string,
  clientId: string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.OFFER_PREPARE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const empId = guard.employeeId

  const admin = createAdminClient()
  const { error } = await admin
    .from('client_product_assignments')
    .delete()
    .eq('product_id', productId)
    .eq('client_id', clientId)

  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/catalog')
  return { ok: true }
}

// ── Get distinct categories and brands for filters ───────────────────────────

export async function getCatalogMeta(): Promise<ActionResult<{
  categories: string[]
  brands: string[]
  clients: { id: string; name: string }[]
}>> {
  const guard = await requireReadPermission(PERMS.OFFER_PREPARE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const empId = guard.employeeId

  const admin = createAdminClient()
  const [catRes, brandRes, clientRes] = await Promise.all([
    admin.from('product_catalog').select('category').not('category', 'is', null).order('category'),
    admin.from('product_catalog').select('brand').not('brand', 'is', null).order('brand'),
    admin.from('clients').select('id, name').eq('is_active', true).order('name'),
  ])

  const categories = [...new Set((catRes.data || []).map((r: any) => r.category).filter(Boolean))]
  const brands = [...new Set((brandRes.data || []).map((r: any) => r.brand).filter(Boolean))]

  return {
    ok: true,
    data: {
      categories,
      brands,
      clients: clientRes.data || [],
    },
  }
}

// ── Client-submitted products: staff review queue ────────────────────────────
//
// review_status / submitted_at / submitted_by_client_id / names only exist once
// migration 20260719140000 has been applied. The read path below therefore uses
// selectWithOptionalColumns and degrades to "nothing pending" rather than
// throwing; the write paths deliberately surface the error instead.

export interface PendingSubmission {
  id: string
  name: string
  category: string | null
  image_url: string | null
  names: Record<string, string>
  submitted_at: string | null
  client_name: string | null
}

export async function listPendingSubmissions(): Promise<ActionResult<{ items: PendingSubmission[] }>> {
  const guard = await requirePermission(PERMS.CATALOG_REVIEW_SUBMISSIONS)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()

  // Pre-migration both attempts fail with 42703 (the review_status filter alone
  // is enough to fail it) and we get null back — which reads as "none pending".
  const rows = await selectWithOptionalColumns<any[]>(
    'id, name, category, image_url',
    ['names', 'submitted_at', 'submitted_by_client_id'],
    cols =>
      admin
        .from('product_catalog')
        .select(cols)
        .eq('review_status', 'pending')
        .order('submitted_at', { ascending: false })
        .limit(200),
  )

  if (!rows || rows.length === 0) return { ok: true, data: { items: [] } }

  // Resolve the submitting client's name separately rather than via a PostgREST
  // embed: the FK doesn't exist pre-migration and a missing relationship fails
  // with a different error code than the column fallback handles.
  const clientIds = [...new Set(rows.map(r => r.submitted_by_client_id).filter(Boolean))] as string[]
  const nameById = new Map<string, string>()
  if (clientIds.length) {
    const { data: clientRows } = await admin.from('clients').select('id, name').in('id', clientIds)
    for (const c of clientRows || []) nameById.set((c as any).id, (c as any).name)
  }

  const items: PendingSubmission[] = rows.map(r => ({
    id: r.id,
    name: r.name,
    category: r.category ?? null,
    image_url: r.image_url ?? null,
    names: (r.names && typeof r.names === 'object' && !Array.isArray(r.names)) ? r.names : {},
    submitted_at: r.submitted_at ?? null,
    client_name: r.submitted_by_client_id ? nameById.get(r.submitted_by_client_id) ?? null : null,
  }))

  return { ok: true, data: { items } }
}

async function setReviewStatus(id: string, status: 'approved' | 'rejected'): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.CATALOG_REVIEW_SUBMISSIONS)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!id) return { ok: false, error: 'Missing product id.' }

  const admin = createAdminClient()
  const now = new Date().toISOString()
  const { error } = await admin
    .from('product_catalog')
    .update({
      review_status: status,
      reviewed_by: guard.employeeId,
      reviewed_at: now,
      updated_at: now,
    })
    .eq('id', id)

  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/catalog')
  return { ok: true }
}

export async function approveSubmission(id: string): Promise<ActionResult> {
  return setReviewStatus(id, 'approved')
}

export async function rejectSubmission(id: string): Promise<ActionResult> {
  return setReviewStatus(id, 'rejected')
}

// ── Local (regional-language) product names ──────────────────────────────────

/** ISO-ish language tag: 'ml', 'ta', 'pt-BR'. */
const LANG_RE = /^[a-z]{2,8}(-[A-Za-z0-9]{2,8})*$/

/**
 * Merge a single language into product_catalog.names WITHOUT clobbering the
 * other languages already stored there. Read-modify-write; an empty value
 * removes that language.
 */
/**
 * Save the three things staff fix on a client submission — the tidied title,
 * the category, and the local-language name — in one call.
 *
 * New products arrive with a client's weekly offer list, where all they type is
 * a name and a photo. Category and a presentable title are the employee's job,
 * so the queue has to be editable, not just approve/reject.
 */
export async function updateSubmission(
  id: string,
  patch: { name?: string; category?: string | null; localName?: string },
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.CATALOG_REVIEW_SUBMISSIONS)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!id) return { ok: false, error: 'Missing product id.' }

  const admin = createAdminClient()
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (patch.name !== undefined) {
    const name = patch.name.trim().replace(/\s+/g, ' ')
    if (!name) return { ok: false, error: 'Product name cannot be empty.' }
    update.name = name
  }
  if (patch.category !== undefined) {
    update.category = patch.category?.trim() || null
  }

  // Read-modify-write so setting the Malayalam name never drops an Arabic one.
  if (patch.localName !== undefined) {
    const { data: existing, error: readErr } = await admin
      .from('product_catalog').select('names').eq('id', id).maybeSingle()
    if (readErr) return { ok: false, error: readErr.message }
    if (!existing) return { ok: false, error: 'Product not found.' }
    const current = ((existing as any).names && typeof (existing as any).names === 'object' && !Array.isArray((existing as any).names))
      ? { ...((existing as any).names as Record<string, string>) }
      : {}
    const trimmed = patch.localName.trim()
    if (trimmed) current.ml = trimmed
    else delete current.ml
    update.names = current
  }

  const { error } = await admin.from('product_catalog').update(update).eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/catalog')
  return { ok: true }
}

export async function updateProductLocalName(
  id: string,
  lang: string,
  value: string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.OFFER_PREPARE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const empId = guard.employeeId
  if (!id) return { ok: false, error: 'Missing product id.' }

  const code = (lang || '').trim().toLowerCase()
  if (!LANG_RE.test(code)) return { ok: false, error: 'Invalid language code.' }

  const admin = createAdminClient()

  const { data: existing, error: readErr } = await admin
    .from('product_catalog')
    .select('names')
    .eq('id', id)
    .maybeSingle()

  if (readErr) return { ok: false, error: readErr.message }
  if (!existing) return { ok: false, error: 'Product not found.' }

  const current = ((existing as any).names && typeof (existing as any).names === 'object' && !Array.isArray((existing as any).names))
    ? { ...((existing as any).names as Record<string, string>) }
    : {}

  const trimmed = (value ?? '').trim()
  if (trimmed) current[code] = trimmed
  else delete current[code]

  const { error } = await admin
    .from('product_catalog')
    .update({ names: current, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/catalog')
  return { ok: true }
}
