/**
 * Staff and brands (server-only, best-effort).
 *
 * Assigning someone to a BRAND (employee_brands) means "every department of
 * that brand" — resolved at read time, like a department assignment, so a
 * department moved into the brand later is picked up with no re-assignment.
 * This is what lets "restrict to own department" confine a Memoura person to
 * Memoura without listing its departments one by one.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadBrandGraph, categoriesOfBrand, servicesOfBrand, type BrandGraph } from './scope'

/** Departments an employee holds through brand assignments. [] when none / unreadable. */
export async function brandCategoryIdsForEmployee(admin: SupabaseClient, employeeId: string): Promise<string[]> {
  try {
    const { data, error } = await admin.from('employee_brands').select('brand_id').eq('employee_id', employeeId)
    if (error || !data?.length) return []
    const brandIds = new Set((data as { brand_id: string }[]).map(r => r.brand_id))
    const graph = await loadBrandGraph(admin)
    return [...graph.categoryBrand].filter(([, b]) => brandIds.has(b)).map(([c]) => c)
  } catch { return [] }
}

export interface BrandMember {
  id: string
  cqid: string | null
  /** How they are in the brand: the whole brand, one of its departments, or a service. */
  via: 'brand' | 'department' | 'service'
}

/**
 * Who works for a brand: assigned to the brand itself, to one of its
 * departments, or to one of its services. CQIDs only — names never leave the
 * server for this list.
 */
export async function loadBrandTeam(admin: SupabaseClient, graph: BrandGraph, brandId: string): Promise<BrandMember[]> {
  const cats = categoriesOfBrand(graph, brandId)
  const svcs = servicesOfBrand(graph, brandId)
  const via = new Map<string, BrandMember['via']>()
  const rank = { brand: 0, department: 1, service: 2 } as const
  const put = (id: string, v: BrandMember['via']) => {
    const cur = via.get(id)
    if (!cur || rank[v] < rank[cur]) via.set(id, v)
  }
  const safe = async <T,>(p: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> => {
    try { const r = await p; return r.error ? [] : (r.data ?? []) } catch { return [] }
  }
  const [byBrand, byCat, bySvc] = await Promise.all([
    safe<{ employee_id: string }>(admin.from('employee_brands').select('employee_id').eq('brand_id', brandId)),
    cats.size ? safe<{ employee_id: string }>(admin.from('employee_service_categories').select('employee_id').in('category_id', [...cats])) : Promise.resolve([]),
    svcs.size ? safe<{ employee_id: string }>(admin.from('employee_services').select('employee_id').in('service_id', [...svcs])) : Promise.resolve([]),
  ])
  for (const r of byBrand) put(r.employee_id, 'brand')
  for (const r of byCat) put(r.employee_id, 'department')
  for (const r of bySvc) put(r.employee_id, 'service')
  if (!via.size) return []

  const emps = await safe<{ id: string; cqid: string | null; is_active: boolean | null }>(
    admin.from('employees').select('id, cqid, is_active').in('id', [...via.keys()]))
  return emps
    .filter(e => e.is_active !== false)
    .map(e => ({ id: e.id, cqid: e.cqid ?? null, via: via.get(e.id)! }))
    .sort((a, b) => (a.cqid ?? '').localeCompare(b.cqid ?? ''))
}
