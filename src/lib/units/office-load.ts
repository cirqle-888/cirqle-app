import 'server-only'
/* eslint-disable @typescript-eslint/no-explicit-any -- rows arrive untyped from PostgREST (see load.ts) */

/**
 * Cirqle's office team (server-only): who is on it, everyone's role, and the
 * permission catalogue, for the Office team page and the HQ report. People
 * by CQID only.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAll } from '@/lib/supabase/server'
import { loadDepartments } from './load'
import { loadOfficeIds } from './membership'
import { officeRoster, type CatalogPerm, type OfficePerson } from './office'

type Admin = SupabaseClient<any, any, any>

export const OFFICE_MIGRATION = 'supabase/migrations/20261128160000_unit_office_staff.sql'

export { loadOfficeIds }

export interface OfficeTeamData {
  /** False until the office list's migration is run (office = anyone on no team). */
  listInstalled: boolean
  roster: OfficePerson[]
  catalog: CatalogPerm[]
  /** role id → the permission keys it has on. */
  roleKeys: Record<string, string[]>
  units: { id: string; name: string }[]
}

export async function loadOfficeTeam(admin: Admin): Promise<OfficeTeamData> {
  const [emps, roles, perms, grants, officeIds, units] = await Promise.all([
    fetchAll(admin.from('employees').select('id, cqid, designation_id').eq('is_active', true).or('is_archived.is.null,is_archived.eq.false').order('cqid')),
    fetchAll(admin.from('designations').select('id, name, is_admin').order('name')),
    fetchAll(admin.from('permissions').select('id, module, key, label, description, display_order').order('display_order')),
    fetchAll(admin.from('designation_permissions').select('designation_id, permission_id').eq('allowed', true)),
    loadOfficeIds(admin),
    loadDepartments(admin),
  ])
  for (const r of [emps, roles, perms, grants]) if (r.error) throw new Error(`Could not load the office team: ${r.error.message}`)

  const catalog: CatalogPerm[] = (perms.data ?? []).map((p: any) => ({
    id: p.id, module: p.module ?? (String(p.key).split('.')[0]), key: p.key, label: p.label ?? null, description: p.description ?? null, order: p.display_order ?? 0,
  }))
  const keyOf = new Map(catalog.map(p => [p.id, p.key]))
  const roleKeys: Record<string, string[]> = {}
  for (const g of (grants.data ?? []) as { designation_id: string; permission_id: string }[]) {
    const k = keyOf.get(g.permission_id)
    if (k) (roleKeys[g.designation_id] ??= []).push(k)
  }
  const active = units.filter(u => u.isActive)
  const unitsOf = new Map<string, string[]>()
  for (const u of active) for (const m of u.members) unitsOf.set(m.employeeId, [...(unitsOf.get(m.employeeId) ?? []), u.id])

  const roster = officeRoster(
    (emps.data ?? []).filter((e: any) => e.cqid).map((e: any) => ({ id: e.id, cqid: e.cqid, designationId: e.designation_id ?? null })),
    (roles.data ?? []).map((r: any) => ({ id: r.id, name: r.name, isAdmin: !!r.is_admin })),
    officeIds,
    unitsOf,
  )
  return { listInstalled: officeIds !== null, roster, catalog, roleKeys, units: active.map(u => ({ id: u.id, name: u.name })) }
}
