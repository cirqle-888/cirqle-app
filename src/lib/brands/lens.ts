/**
 * The brand lens — "show me only Memoura" (server-only).
 *
 * One platform, two ways to look at it: "All brands" (the default, everything
 * together) or one brand at a time. The choice is a cookie set from the
 * sidebar switcher and read by the pages that honour it (Tasks, Clients).
 *
 * A lens only ever NARROWS what a page shows. It is not a permission: what a
 * person may see is still decided by their role and department scope, so
 * anyone may pick any brand without seeing anything extra.
 */

import { cookies } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Brand } from './brands'
import { loadBrandGraph, type BrandGraph } from './scope'
import { loadBrands } from './load'

export const BRAND_LENS_COOKIE = 'cq_brand'

export async function readBrandLensId(): Promise<string | null> {
  try {
    const v = (await cookies()).get(BRAND_LENS_COOKIE)?.value
    return v && /^[0-9a-f-]{36}$/i.test(v) ? v : null
  } catch { return null }
}

export interface BrandLens {
  brand: Brand
  graph: BrandGraph
}

/** The active lens, or null for "All brands" (also when the brand is gone). */
export async function resolveBrandLens(admin: SupabaseClient): Promise<BrandLens | null> {
  const id = await readBrandLensId()
  if (!id) return null
  const brands = await loadBrands(admin)
  const brand = brands.find(b => b.id === id && b.is_active)
  if (!brand || brands.length < 2) return null
  return { brand, graph: await loadBrandGraph(admin, brands) }
}
