'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCurrentEmployeeId } from '@/lib/auth/enforce'
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
  const empId = await resolveCurrentEmployeeId()
  if (!empId) return { ok: false, error: 'Not signed in.' }

  const admin = createAdminClient()
  let q = admin
    .from('product_catalog')
    .select(`
      id, product_code, name, weight, category, brand, barcode,
      image_url, status, notes, created_at, updated_at,
      images:product_catalog_images(id, version, url, is_primary, created_at),
      assignments:client_product_assignments(client_id, is_active)
    `)
    .order('name')

  if (filters?.status && filters.status !== 'all') q = q.eq('status', filters.status)
  if (filters?.category) q = q.eq('category', filters.category)
  if (filters?.brand) q = q.eq('brand', filters.brand)
  if (filters?.search) q = q.ilike('name', `%${filters.search}%`)

  const { data, error } = await q
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { products: data || [] } }
}

// ── Create single product ────────────────────────────────────────────────────

export async function createProduct(row: ProductRow): Promise<ActionResult<{ product: any }>> {
  const empId = await resolveCurrentEmployeeId()
  if (!empId) return { ok: false, error: 'Not signed in.' }

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
  const empId = await resolveCurrentEmployeeId()
  if (!empId) return { ok: false, error: 'Not signed in.' }

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
  const empId = await resolveCurrentEmployeeId()
  if (!empId) return { ok: false, error: 'Not signed in.' }
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
  const empId = await resolveCurrentEmployeeId()
  if (!empId) return { ok: false, error: 'Not signed in.' }

  const admin = createAdminClient()
  const ext = filename.split('.').pop() || 'jpg'
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
  const empId = await resolveCurrentEmployeeId()
  if (!empId) return { ok: false, error: 'Not signed in.' }

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
  const empId = await resolveCurrentEmployeeId()
  if (!empId) return { ok: false, error: 'Not signed in.' }

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
  const empId = await resolveCurrentEmployeeId()
  if (!empId) return { ok: false, error: 'Not signed in.' }

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
  const empId = await resolveCurrentEmployeeId()
  if (!empId) return { ok: false, error: 'Not signed in.' }

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
  const empId = await resolveCurrentEmployeeId()
  if (!empId) return { ok: false, error: 'Not signed in.' }

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
  const empId = await resolveCurrentEmployeeId()
  if (!empId) return { ok: false, error: 'Not signed in.' }

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
