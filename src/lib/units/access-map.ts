import 'server-only'

/**
 * The Access map — who reaches which part of Cirqle, in one place
 * (server-only). Read by /dashboard/units/access.
 *
 * Reach is explicit (decided 2026-11-27): nobody but an Admin sees anything by
 * default. A person's reach is the FIRST of:
 *
 *   admin     — an Admin designation: everything
 *   units     — on a unit's team: that unit's clients and work only, and only
 *               the unit-team pages (lib/units/access)
 *   all       — their designation holds "View all" (scope.view_all)
 *   org_unit  — their designation scopes them by org unit (scope.by_unit)
 *   assigned  — the departments / services assigned to them
 *   nothing   — none of the above: they see no clients and no work but their own
 *
 * A client's departments are what it buys (its services' categories), unless
 * it is PINNED to one department. A client in more than one unit is MIXED:
 * each team sees the client, but only its own work for it.
 *
 * People are shown by CQID only.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { PERMS } from '@/lib/permissions/keys'
import { loadDepartments } from './load'
import type { DeptConfig } from './engine'

type Admin = SupabaseClient

export type ReachKind = 'admin' | 'units' | 'all' | 'org_unit' | 'assigned' | 'nothing'

export interface PersonRow {
  id: string
  cqid: string
  designationId: string | null
  designationName: string | null
  reach: ReachKind
  /** unit id → role, for the people on unit teams. */
  units: Record<string, 'lead' | 'member'>
  /** Departments assigned directly (employee_service_categories, brands, direct services). */
  assignedDepartmentIds: string[]
}

export interface ClientRow {
  id: string
  name: string
  /** Departments from what it buys. */
  boughtDepartmentIds: string[]
  /** The department it is pinned to, if any. */
  pinnedDepartmentId: string | null
  /** The units it falls in (by pin, else by what it buys). */
  unitIds: string[]
  mixed: boolean
}

export interface AccessMap {
  units: DeptConfig[]
  departments: { id: string; name: string; unitId: string | null }[]
  people: PersonRow[]
  clients: ClientRow[]
  /** Designations whose staff get no reach from the designation itself. */
  designationsWithoutReach: { id: string; name: string; people: string[] }[]
}

const REACH_KEYS = [PERMS.SCOPE_VIEW_ALL, PERMS.SCOPE_BY_UNIT, PERMS.SCOPE_BY_SERVICE] as string[]

async function all<T>(p: PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T[]> {
  const r = await p
  if (r.error) throw new Error(`Could not read ${what}: ${r.error.message}`)
  return (r.data ?? []) as T[]
}

export async function loadAccessMap(admin: Admin): Promise<AccessMap> {
  const [units, cats, services, emps, desigs, desigPerms, members, catAssign, svcAssign, brandAssign, clients, pricing] = await Promise.all([
    loadDepartments(admin),
    all<{ id: string; name: string; brand_id: string | null; is_active: boolean | null }>(admin.from('service_categories').select('id, name, brand_id, is_active').order('display_order').order('name'), 'departments'),
    all<{ id: string; category_id: string | null }>(admin.from('services').select('id, category_id'), 'services'),
    all<{ id: string; cqid: string | null; designation_id: string | null }>(admin.from('employees').select('id, cqid, designation_id').eq('is_active', true).order('cqid'), 'employees'),
    all<{ id: string; name: string; is_admin: boolean | null }>(admin.from('designations').select('id, name, is_admin'), 'designations'),
    all<{ designation_id: string; permission: { key: string } | { key: string }[] | null }>(admin.from('designation_permissions').select('designation_id, permission:permission_id(key)').eq('allowed', true), 'designation permissions'),
    all<{ unit_id: string; employee_id: string; role: string }>(admin.from('business_unit_members').select('unit_id, employee_id, role'), 'unit teams'),
    all<{ employee_id: string; category_id: string }>(admin.from('employee_service_categories').select('employee_id, category_id'), 'department assignments'),
    all<{ employee_id: string; service_id: string }>(admin.from('employee_services').select('employee_id, service_id'), 'service assignments'),
    all<{ employee_id: string; brand_id: string }>(admin.from('employee_brands').select('employee_id, brand_id'), 'brand assignments').catch(() => []),
    all<{ id: string; name: string; department_id: string | null }>(admin.from('clients').select('id, name, department_id').eq('is_active', true).order('name'), 'clients'),
    all<{ client_id: string | null; service_id: string | null }>(admin.from('client_service_pricing').select('client_id, service_id').eq('is_active', true).range(0, 9999), 'client services'),
  ])

  // Department → unit (active units; a category counts in one unit only).
  const unitOfDept = new Map<string, string>()
  for (const u of units) if (u.isActive) for (const c of u.categoryIds) if (!unitOfDept.has(c)) unitOfDept.set(c, u.id)
  const serviceDept = new Map(services.map(s => [s.id, s.category_id]))

  // ── People ──
  const designation = new Map(desigs.map(d => [d.id, d]))
  const keysOf = new Map<string, Set<string>>()
  for (const r of desigPerms) {
    const key = (Array.isArray(r.permission) ? r.permission[0] : r.permission)?.key
    if (!key) continue
    const set = keysOf.get(r.designation_id) ?? new Set<string>()
    set.add(key)
    keysOf.set(r.designation_id, set)
  }
  const brandDepts = new Map<string, string[]>()
  for (const c of cats) if (c.brand_id) brandDepts.set(c.brand_id, [...(brandDepts.get(c.brand_id) ?? []), c.id])

  const people: PersonRow[] = emps.filter(e => e.cqid).map(e => {
    const d = e.designation_id ? designation.get(e.designation_id) : undefined
    const keys = (e.designation_id && keysOf.get(e.designation_id)) || new Set<string>()
    const myUnits: Record<string, 'lead' | 'member'> = {}
    for (const m of members) if (m.employee_id === e.id) myUnits[m.unit_id] = m.role === 'lead' ? 'lead' : 'member'
    const assigned = new Set<string>()
    for (const a of catAssign) if (a.employee_id === e.id) assigned.add(a.category_id)
    for (const a of svcAssign) if (a.employee_id === e.id) { const c = serviceDept.get(a.service_id); if (c) assigned.add(c) }
    for (const a of brandAssign) if (a.employee_id === e.id) for (const c of brandDepts.get(a.brand_id) ?? []) assigned.add(c)
    const activeUnit = Object.keys(myUnits).some(id => units.find(u => u.id === id)?.isActive)
    const reach: ReachKind = d?.is_admin ? 'admin'
      : activeUnit ? 'units'
      : keys.has(PERMS.SCOPE_VIEW_ALL) ? 'all'
      : keys.has(PERMS.SCOPE_BY_UNIT) ? 'org_unit'
      : assigned.size ? 'assigned' : 'nothing'
    return {
      id: e.id, cqid: e.cqid ?? '', designationId: e.designation_id, designationName: d?.name ?? null,
      reach, units: myUnits, assignedDepartmentIds: [...assigned],
    }
  })

  const designationsWithoutReach = desigs
    .filter(d => !d.is_admin && !REACH_KEYS.some(k => keysOf.get(d.id)?.has(k)))
    .map(d => ({ id: d.id, name: d.name, people: people.filter(p => p.designationId === d.id && (p.reach === 'nothing' || p.reach === 'assigned')).map(p => p.cqid) }))
    .filter(d => d.people.length > 0)
    .sort((a, b) => b.people.length - a.people.length)

  // ── Clients ──
  const bought = new Map<string, Set<string>>()
  for (const p of pricing) {
    if (!p.client_id || !p.service_id) continue
    const dept = serviceDept.get(p.service_id)
    if (!dept) continue
    const set = bought.get(p.client_id) ?? new Set<string>()
    set.add(dept)
    bought.set(p.client_id, set)
  }
  const clientRows: ClientRow[] = clients.map(c => {
    const boughtIds = [...(bought.get(c.id) ?? [])]
    const effective = c.department_id ? [c.department_id] : boughtIds
    const unitIds = [...new Set(effective.map(d => unitOfDept.get(d)).filter((u): u is string => !!u))]
    return {
      id: c.id, name: c.name, boughtDepartmentIds: boughtIds, pinnedDepartmentId: c.department_id,
      unitIds, mixed: unitIds.length > 1,
    }
  })

  return {
    units,
    departments: cats.filter(c => c.is_active !== false).map(c => ({ id: c.id, name: c.name, unitId: unitOfDept.get(c.id) ?? null })),
    people,
    clients: clientRows,
    designationsWithoutReach,
  }
}
