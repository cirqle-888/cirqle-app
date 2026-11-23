'use server'

/**
 * Shop catalogue server actions — the write path for /dashboard/shop.
 *
 * House pattern: requirePermission → guard.ok → createAdminClient → mutation →
 * revalidatePath → { ok, error?, data? }. The three shop_* tables are
 * server-only; the browser changes them through these and nothing else, and
 * every value is cleaned again here whatever the form sent.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { revalidatePath } from 'next/cache'
import {
  SHOP_KEY, cleanBanner, cleanProduct, cleanSettings, slugify,
  type ShopBanner, type ShopProduct, type ShopSettings,
} from '@/lib/shop/catalogue'

const REVALIDATE = '/dashboard/shop'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

const PRODUCT_COLS = 'id, slug, name, meta, price, pieces, badge, description, needs, who, occ, ready, image_url, active, sort'
const BANNER_COLS = 'id, title, body, starts_on, ends_on, free_extra, free_with, active, sort'

export interface ProductInput {
  id?: string | null
  name: string
  meta?: string | null
  price: number | string
  pieces?: number | string | null
  badge?: string | null
  description?: string | null
  needs?: string | string[]
  who?: string[]
  occ?: string[]
  ready?: boolean
  imageUrl?: string | null
  active?: boolean
  sort?: number | string | null
}

/** Add a gift (no id) or change one (with id). A gift's website id never changes once made. */
export async function saveProduct(input: ProductInput): Promise<ActionResult<ShopProduct>> {
  const guard = await requirePermission(PERMS.ORDERS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const c = cleanProduct({
    name: input.name, meta: input.meta, price: input.price, pieces: input.pieces, badge: input.badge,
    description: input.description, needs: input.needs, who: input.who, occ: input.occ,
    ready: input.ready === true, image_url: input.imageUrl, active: input.active !== false, sort: input.sort,
  })
  if (!c.name) return { ok: false, error: 'Give the gift a name.' }
  if (c.price <= 0) return { ok: false, error: 'Add a price above zero.' }

  const row = {
    name: c.name, meta: c.meta, price: c.price, pieces: c.pieces, badge: c.badge, description: c.description,
    needs: c.ready ? [] : c.needs, who: c.who, occ: c.occ, ready: c.ready, image_url: c.image_url, active: c.active,
  }
  const admin = createAdminClient()

  if (input.id) {
    const { data, error } = await admin
      .from('shop_products')
      .update({ ...row, ...(input.sort != null && input.sort !== '' ? { sort: c.sort } : {}) })
      .eq('id', input.id).is('deleted_at', null)
      .select(PRODUCT_COLS).maybeSingle()
    if (error) return { ok: false, error: error.message }
    if (!data) return { ok: false, error: 'This gift no longer exists.' }
    revalidatePath(REVALIDATE)
    return { ok: true, data: cleanProduct(data as Record<string, unknown>) }
  }

  // New gift: make a website id from the name, and keep it unique (deleted gifts keep theirs,
  // because an old order on a buyer's phone may still name it).
  const base = slugify(c.name) || 'gift'
  const { data: taken, error: readErr } = await admin.from('shop_products').select('slug, sort')
  if (readErr) return { ok: false, error: readErr.message }
  const used = new Set((taken ?? []).map(r => String(r.slug)))
  let slug = base
  for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`
  const lastSort = Math.max(0, ...(taken ?? []).map(r => Number(r.sort) || 0))

  const { data, error } = await admin
    .from('shop_products')
    .insert({ ...row, slug, sort: lastSort + 10 })
    .select(PRODUCT_COLS).single()
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true, data: cleanProduct(data as Record<string, unknown>) }
}

/** Show or hide a gift on the website. */
export async function setProductActive(id: string, active: boolean): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ORDERS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const { error } = await createAdminClient().from('shop_products').update({ active: active === true }).eq('id', id).is('deleted_at', null)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** Move a gift before or after its neighbour by swapping their places. */
export async function swapProductOrder(idA: string, idB: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ORDERS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { data, error } = await admin.from('shop_products').select('id, sort').in('id', [idA, idB]).is('deleted_at', null)
  if (error) return { ok: false, error: error.message }
  const a = data?.find(r => r.id === idA), b = data?.find(r => r.id === idB)
  if (!a || !b) return { ok: false, error: 'One of the gifts no longer exists.' }
  const sa = Number(a.sort) || 0, sb = Number(b.sort) || 0
  const r1 = await admin.from('shop_products').update({ sort: sb === sa ? sa + 1 : sb }).eq('id', idA)
  const r2 = await admin.from('shop_products').update({ sort: sa }).eq('id', idB)
  if (r1.error || r2.error) return { ok: false, error: (r1.error ?? r2.error)!.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** Remove a gift for good from the list (kept in the database, hidden everywhere). */
export async function deleteProduct(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ORDERS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const { error } = await createAdminClient().from('shop_products')
    .update({ deleted_at: new Date().toISOString(), active: false }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

export interface BannerInput {
  id?: string | null
  title?: string | null
  body: string
  startsOn?: string | null
  endsOn?: string | null
  freeExtra?: string | null
  freeWith?: string | null
  active?: boolean
}

export async function saveBanner(input: BannerInput): Promise<ActionResult<ShopBanner>> {
  const guard = await requirePermission(PERMS.ORDERS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const c = cleanBanner({
    title: input.title, body: input.body, starts_on: input.startsOn, ends_on: input.endsOn,
    free_extra: input.freeExtra, free_with: input.freeWith, active: input.active !== false,
  })
  if (!c.body) return { ok: false, error: 'Write the banner text.' }
  if (c.starts_on && c.ends_on && c.ends_on < c.starts_on) return { ok: false, error: 'The end date is before the start date.' }
  if (c.free_extra && !c.free_with) return { ok: false, error: 'Choose the gift that gets the free extra.' }

  const row = {
    title: c.title, body: c.body, starts_on: c.starts_on, ends_on: c.ends_on,
    free_extra: c.free_extra, free_with: c.free_with, active: c.active,
  }
  const admin = createAdminClient()
  if (input.id) {
    const { data, error } = await admin.from('shop_banners').update(row).eq('id', input.id).is('deleted_at', null).select(BANNER_COLS).maybeSingle()
    if (error) return { ok: false, error: error.message }
    if (!data) return { ok: false, error: 'This banner no longer exists.' }
    revalidatePath(REVALIDATE)
    return { ok: true, data: cleanBanner(data as Record<string, unknown>) }
  }
  // A new banner goes first: the newest announcement is the one meant to show.
  const { data: rows, error: readErr } = await admin.from('shop_banners').select('sort').is('deleted_at', null)
  if (readErr) return { ok: false, error: readErr.message }
  const first = Math.min(10, ...(rows ?? []).map(r => Number(r.sort) || 0))
  const { data, error } = await admin.from('shop_banners').insert({ ...row, sort: first - 10 }).select(BANNER_COLS).single()
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true, data: cleanBanner(data as Record<string, unknown>) }
}

export async function setBannerActive(id: string, active: boolean): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ORDERS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const { error } = await createAdminClient().from('shop_banners').update({ active: active === true }).eq('id', id).is('deleted_at', null)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

export async function deleteBanner(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ORDERS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const { error } = await createAdminClient().from('shop_banners')
    .update({ deleted_at: new Date().toISOString(), active: false }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** Print prices, delivery charges, extras and the two highlight cards, saved together. */
export async function saveSettings(input: unknown): Promise<ActionResult<ShopSettings>> {
  const guard = await requirePermission(PERMS.ORDERS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const value = cleanSettings(input)
  if (value.sizes.some(s => s.price <= 0)) return { ok: false, error: 'Every print size needs a price above zero.' }
  const { error } = await createAdminClient().from('shop_settings').upsert({ shop: SHOP_KEY, value }, { onConflict: 'shop' })
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true, data: value }
}
