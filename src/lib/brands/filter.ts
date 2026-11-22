/**
 * The brand filter every list page applies (server-only).
 *
 * Resolved once per request (React `cache`): the active brand lens — from a
 * brand workspace, a confinement, or the sidebar switcher — plus the set of
 * clients in that brand. Pages keep a row when:
 *
 *   · it belongs to a client in the brand, or
 *   · it is Cirqle's own and carries that brand (or a service of it).
 *
 * null = "All brands": pages show everything, exactly as before.
 */

import { cache } from 'react'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import type { Brand } from './brands'
import { resolveBrandLens } from './lens'
import { brandOfService, clientBrandMap, type BrandGraph } from './scope'

export interface BrandFilter {
  brand: Brand
  graph: BrandGraph
  /** Clients that belong to the brand (by department, purchases or work). */
  clientIds: Set<string>
}

export const getBrandFilter = cache(async (): Promise<BrandFilter | null> => {
  const admin = createAdminClient()
  const lens = await resolveBrandLens(admin)
  if (!lens) return null
  const safe = async (p: PromiseLike<{ data?: unknown; error?: unknown }>) => {
    try { const r = await p; return r.error ? [] : ((r.data ?? []) as any[]) } catch { return [] as any[] }
  }
  const [clients, pricing, tasks] = await Promise.all([
    safe(fetchAll(admin.from('clients').select('id, department_id').order('id'))),
    safe(fetchAll(admin.from('client_service_pricing').select('client_id, service_id').eq('is_active', true).order('client_id'))),
    safe(fetchAll(admin.from('tasks').select('client_id, service_id').is('deleted_at', null).not('client_id', 'is', null).order('id'))),
  ])
  const map = clientBrandMap(lens.graph, { clients, pricing, tasks })
  const clientIds = new Set([...map].filter(([, b]) => b.has(lens.brand.id)).map(([c]) => c))
  return { brand: lens.brand, graph: lens.graph, clientIds }
})

/** Is a row in the brand? Client rows by client; own rows by brand or service. */
export function inBrand(
  f: BrandFilter,
  row: { clientId?: string | null; brandId?: string | null; serviceId?: string | null },
): boolean {
  if (row.clientId) return f.clientIds.has(row.clientId)
  if (row.brandId) return row.brandId === f.brand.id
  if (row.serviceId) return brandOfService(f.graph, row.serviceId) === f.brand.id
  // Cirqle's own with nothing to say which brand: the default brand's.
  return f.brand.is_default
}
