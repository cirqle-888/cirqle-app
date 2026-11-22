/**
 * Brand scope — which departments, services, clients, tasks and staff belong
 * to each of Cirqle's brands.
 *
 * A brand OWNS departments (service categories), exactly as a department owns
 * services, so every answer here is derived from the department structure the
 * app already has — nothing is copied or stored twice:
 *
 *   department → brand      service_categories.brand_id (NULL = default brand)
 *   service    → brand      services.brand_id override, else its department's
 *   client     → brands     its department override's brand, else the brands of
 *                           everything it buys or has had work on (one client
 *                           can be in several: flyers AND social media)
 *   task       → brand      internal work: its own brand_id; client work: the
 *                           brand of its service; no service → default brand
 *
 * Pure: the graph is built once per request (loadBrandGraph) and every
 * question is a lookup.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { defaultBrand, type Brand } from './brands'
import { loadBrands } from './load'

export interface BrandGraph {
  brands: Brand[]
  defaultId: string | null
  /** department id → brand id (NULL department brand resolved to the default). */
  categoryBrand: Map<string, string>
  /** service id → brand id (override → department → default). */
  serviceBrand: Map<string, string>
}

export interface GraphCategory { id: string; brand_id?: string | null }
export interface GraphService { id: string; category_id?: string | null; brand_id?: string | null }

export function buildBrandGraph(brands: Brand[], categories: GraphCategory[], services: GraphService[]): BrandGraph {
  const defaultId = defaultBrand(brands)?.id ?? null
  const known = new Set(brands.map(b => b.id))
  const resolve = (id: string | null | undefined) => (id && known.has(id) ? id : defaultId)

  const categoryBrand = new Map<string, string>()
  for (const c of categories) {
    const b = resolve(c.brand_id)
    if (b) categoryBrand.set(c.id, b)
  }
  const serviceBrand = new Map<string, string>()
  for (const s of services) {
    const own = s.brand_id && known.has(s.brand_id) ? s.brand_id : null
    const b = own ?? (s.category_id ? categoryBrand.get(s.category_id) ?? null : null) ?? defaultId
    if (b) serviceBrand.set(s.id, b)
  }
  return { brands, defaultId, categoryBrand, serviceBrand }
}

/** The brand of a service; a missing/unknown service counts as the default brand. */
export function brandOfService(g: BrandGraph, serviceId: string | null | undefined): string | null {
  return (serviceId ? g.serviceBrand.get(serviceId) : null) ?? g.defaultId
}

/** The brand a task's work belongs to. */
export function brandOfTask(
  g: BrandGraph,
  t: { client_id?: string | null; service_id?: string | null; brand_id?: string | null },
): string | null {
  if (!t.client_id && t.brand_id && g.brands.some(b => b.id === t.brand_id)) return t.brand_id
  return brandOfService(g, t.service_id)
}

export function categoriesOfBrand(g: BrandGraph, brandId: string): Set<string> {
  return new Set([...g.categoryBrand].filter(([, b]) => b === brandId).map(([c]) => c))
}

export function servicesOfBrand(g: BrandGraph, brandId: string): Set<string> {
  return new Set([...g.serviceBrand].filter(([, b]) => b === brandId).map(([s]) => s))
}

/**
 * Client id → the brands it belongs to. A department override decides alone
 * (override means override, as for departments); otherwise the brands of every
 * service the client buys or has work on. A client with neither is in no
 * brand yet — visible under "All brands" only, never silently in the default.
 */
export function clientBrandMap(
  g: BrandGraph,
  input: {
    clients: { id: string; department_id?: string | null }[]
    /** client_service_pricing rows (active commitments). */
    pricing: { client_id: string | null; service_id: string | null }[]
    /** Task rows (client_id, service_id). */
    tasks: { client_id: string | null; service_id: string | null }[]
  },
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const add = (clientId: string | null, brandId: string | null | undefined) => {
    if (!clientId || !brandId) return
    let set = out.get(clientId)
    if (!set) { set = new Set(); out.set(clientId, set) }
    set.add(brandId)
  }
  const overridden = new Set<string>()
  for (const c of input.clients) {
    if (!c.department_id) continue
    overridden.add(c.id)
    add(c.id, g.categoryBrand.get(c.department_id) ?? g.defaultId)
  }
  for (const rows of [input.pricing, input.tasks]) {
    for (const r of rows) {
      if (!r.client_id || overridden.has(r.client_id) || !r.service_id) continue
      add(r.client_id, g.serviceBrand.get(r.service_id) ?? null)
    }
  }
  return out
}

/** Keep the rows whose brand (by `brandOf`) is `brandId`. No brand = no filter. */
export function filterToBrand<T>(rows: readonly T[], brandId: string | null, brandOf: (row: T) => string | null): T[] {
  if (!brandId) return rows as T[]
  return rows.filter(r => brandOf(r) === brandId)
}

// ─── Server loader ───────────────────────────────────────────────────────────

/**
 * Brands + the department/service links, best-effort: before the brand
 * migrations the columns are missing and every lookup falls back to the
 * default brand (or to nothing when there are no brands at all).
 */
export async function loadBrandGraph(admin: SupabaseClient, brandsIn?: Brand[]): Promise<BrandGraph> {
  const brands = brandsIn ?? await loadBrands(admin)
  if (!brands.length) return buildBrandGraph([], [], [])
  const read = async <T,>(table: string, withBrand: string, without: string): Promise<T[]> => {
    try {
      let { data, error } = await admin.from(table).select(withBrand)
      if (error) ({ data, error } = await admin.from(table).select(without))
      return error ? [] : ((data ?? []) as unknown as T[])
    } catch { return [] }
  }
  const [categories, services] = await Promise.all([
    read<GraphCategory>('service_categories', 'id, brand_id', 'id'),
    read<GraphService>('services', 'id, category_id, brand_id', 'id, category_id'),
  ])
  return buildBrandGraph(brands, categories, services)
}
