/**
 * Brand reads. Best-effort throughout: before migration 20261122100000 the
 * table and columns do not exist, and no page may break because of that —
 * brands simply don't show.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { sortBrands, type Brand } from './brands'

const BRAND_COLS = 'id, name, slug, tagline, color, logo_url, whatsapp_number, website, is_default, is_active, show_on_invoices, display_order'

/** Every brand (or only active ones), in display order. [] when unreadable. */
export async function loadBrands(
  admin: SupabaseClient,
  opts: { activeOnly?: boolean } = {},
): Promise<Brand[]> {
  const read = (cols: string) => {
    let q = admin.from('brands').select(cols)
    if (opts.activeOnly) q = q.eq('is_active', true)
    return q
  }
  try {
    // task_label arrives with 20261122120000; without it, read the rest.
    let { data, error } = await read(`${BRAND_COLS}, task_label`)
    if (error) ({ data, error } = await read(BRAND_COLS))
    if (error) return []
    return sortBrands((data ?? []) as unknown as Brand[])
  } catch { return [] }
}

/** One brand by slug or id. */
export async function loadBrand(admin: SupabaseClient, slugOrId: string): Promise<Brand | null> {
  const all = await loadBrands(admin)
  return all.find(b => b.slug === slugOrId || b.id === slugOrId) ?? null
}
