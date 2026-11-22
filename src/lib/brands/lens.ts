/**
 * The brand lens — "show me only Memoura" (server-only).
 *
 * One platform, two ways to look at it: "All brands" (the default, everything
 * together) or one brand at a time. Two sources, first wins:
 *
 *   1. the viewer's current WORKSPACE, when it belongs to a brand — a
 *      "Memoura" workspace is a complete Memoura view, and its members live
 *      in it (Settings → Workspaces);
 *   2. otherwise the sidebar Brand switcher's cookie.
 *
 * Read by the pages that honour it (Tasks, Clients).
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
import { loadCurrentUser } from '@/lib/permissions/check'
import { confinedBrandIds } from './restriction'

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

/** The brand of the viewer's current workspace, if it has one. Best-effort. */
export async function workspaceBrandId(admin: SupabaseClient): Promise<string | null> {
  try {
    const me = await loadCurrentUser().catch(() => null)
    if (!me?.employeeId) return null
    const { data: emp } = await admin.from('employees').select('current_workspace_id').eq('id', me.employeeId).maybeSingle()
    const wsId = (emp as { current_workspace_id?: string | null } | null)?.current_workspace_id
    if (!wsId) return null
    const { data: ws, error } = await admin.from('workspaces').select('brand_id').eq('id', wsId).maybeSingle()
    if (error) return null                              // column not migrated
    return (ws as { brand_id?: string | null } | null)?.brand_id ?? null
  } catch { return null }
}

/** The active lens, or null for "All brands" (also when the brand is gone). */
export async function resolveBrandLens(admin: SupabaseClient): Promise<BrandLens | null> {
  // Confined members can't look anywhere else: their workspace's brand if it
  // is one of theirs, otherwise their first brand. The cookie is ignored.
  const me = await loadCurrentUser().catch(() => null)
  const confined = await confinedBrandIds(admin, me)
  const fromWorkspace = await workspaceBrandId(admin)
  const id = confined.length
    ? (fromWorkspace && confined.includes(fromWorkspace) ? fromWorkspace : confined[0])
    : fromWorkspace ?? (await readBrandLensId())
  if (!id) return null
  const brands = await loadBrands(admin)
  const brand = brands.find(b => b.id === id && b.is_active)
  if (!brand || brands.length < 2) return null
  return { brand, graph: await loadBrandGraph(admin, brands) }
}
