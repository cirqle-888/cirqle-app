/**
 * Brand confinement (server-only, best-effort).
 *
 * A non-admin who is a member of a workspace with a brand AND "restrict
 * members" on is confined to that brand everywhere: the service and
 * department scoping treat the brand's services/departments as their
 * assignment, and the brand lens is forced to it. Admins are never confined.
 * A read failure means "not confined" — the same fail-open rule the other
 * scopes follow, so a hiccup never blanks someone's app.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CurrentUser } from '@/lib/permissions/check'
import { loadBrandGraph, categoriesOfBrand, servicesOfBrand } from './scope'

export async function confinedBrandIds(admin: SupabaseClient, me: CurrentUser | null): Promise<string[]> {
  if (!me || me.isAdmin || !me.employeeId) return []
  try {
    const { data: mem, error: memErr } = await admin.from('workspace_members').select('workspace_id').eq('employee_id', me.employeeId)
    if (memErr || !mem?.length) return []
    const { data: ws, error } = await admin.from('workspaces')
      .select('brand_id').in('id', (mem as { workspace_id: string }[]).map(m => m.workspace_id))
      .eq('restrict_members', true).not('brand_id', 'is', null)
    if (error) return []                                   // column not migrated
    return [...new Set((ws ?? []).map((w: { brand_id: string }) => w.brand_id))]
  } catch { return [] }
}

/** The services and departments a confined person may see. null = not confined. */
export async function confinedScope(
  admin: SupabaseClient, me: CurrentUser | null,
): Promise<{ brandIds: string[]; serviceIds: Set<string>; categoryIds: Set<string> } | null> {
  const brandIds = await confinedBrandIds(admin, me)
  if (!brandIds.length) return null
  const graph = await loadBrandGraph(admin)
  const serviceIds = new Set<string>(), categoryIds = new Set<string>()
  for (const b of brandIds) {
    for (const s of servicesOfBrand(graph, b)) serviceIds.add(s)
    for (const c of categoriesOfBrand(graph, b)) categoryIds.add(c)
  }
  return { brandIds, serviceIds, categoryIds }
}
