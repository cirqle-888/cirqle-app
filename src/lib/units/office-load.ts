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
import { officeRoster, type CatalogPerm, type OfficePerson } from './office'

type Admin = SupabaseClient<any, any, any>

export const OFFICE_MIGRATION = 'supabase/migrations/20261128160000_unit_office_staff.sql'

const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message ?? ''))

/** The office list; null while its migration has not been run. */
export async function loadOfficeIds(admin: Admin): Promise<Set<string> | null> {
  const { data, error } = await admin.from('business_unit_office_staff').select('employee_id')
  if (error) {
    if (missing(error)) return null
    throw new Error(`Could not read the office team: ${error.message}`)
  }
  return new Set((data ?? []).map((r: any) => r.employee_id as string))
}

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
