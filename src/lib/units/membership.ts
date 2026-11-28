import 'server-only'

/**
 * Who belongs to which unit (server-only, service role).
 *
 * A non-admin member of an ACTIVE unit is confined to it: their data is
 * narrowed to the unit's departments (lib/brands/restriction → confinedScope)
 * and the pages they may open are the allow-list in ./access.
 *
 * Fail-closed: a read error other than "the table is not there yet" throws,
 * so a hiccup can never quietly show a unit member everything.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CurrentUser } from '@/lib/permissions/check'
import { unitLockOf, type UnitLock } from './access'

type Admin = SupabaseClient

/** lead / member see the whole unit's work; staff see only the work given to them. */
export type UnitRole = 'lead' | 'member' | 'staff'
export const unitRole = (v: unknown): UnitRole => (v === 'lead' || v === 'staff' ? v : 'member')

export interface MyUnit {
  id: string
  slug: string
  name: string
  categoryIds: string[]
  teamSeesResults: boolean
  role: UnitRole
}

const notInstalled = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === 'PGRST205' || e.code === '42P01' || /does not exist|schema cache/i.test(e.message ?? ''))

/** The active units an employee belongs to. [] before the migration (two small indexed reads). */
export async function unitsOfEmployee(admin: Admin, employeeId: string): Promise<MyUnit[]> {
  const { data: mem, error } = await admin.from('business_unit_members').select('unit_id, role').eq('employee_id', employeeId)
  if (error) {
    if (notInstalled(error)) return []
    throw new Error(`Could not check unit membership: ${error.message}`)
  }
  if (!mem?.length) return []
  const role = new Map((mem as { unit_id: string; role: string }[]).map(m => [m.unit_id, unitRole(m.role)]))
  const { data: units, error: uErr } = await admin.from('business_units')
    .select('id, slug, name, category_ids, team_sees_results, is_active').in('id', [...role.keys()]).eq('is_active', true)
  if (uErr) throw new Error(`Could not check unit membership: ${uErr.message}`)
  return ((units ?? []) as { id: string; slug: string; name: string; category_ids: string[] | null; team_sees_results: boolean }[])
    .map(u => ({
      id: u.id, slug: u.slug, name: u.name, categoryIds: u.category_ids ?? [],
      teamSeesResults: !!u.team_sees_results, role: role.get(u.id) ?? 'member',
    }))
}

/** Is this person confined to their unit(s)? Admins never are. */
export async function isUnitConfined(admin: Admin, me: Pick<CurrentUser, 'isAdmin' | 'employeeId'> | null): Promise<boolean> {
  if (!me || me.isAdmin || !me.employeeId) return false
  return (await unitsOfEmployee(admin, me.employeeId)).length > 0
}

/** How this person is held to unit pages: false, true (team) or 'staff'. Admins never are. */
export async function unitLockFor(admin: Admin, me: Pick<CurrentUser, 'isAdmin' | 'employeeId'> | null): Promise<UnitLock> {
  if (!me || me.isAdmin || !me.employeeId) return false
  return unitLockOf((await unitsOfEmployee(admin, me.employeeId)).map(u => u.role))
}

/**
 * The departments (service categories) a confined member may see, or null
 * when they are not confined. An empty array means "confined to nothing" —
 * a unit with a team but no work yet shows its team nothing, never everything.
 * A unit where the person is STAFF gives them none of its departments: they
 * see only the tasks given to them (lib/scope/service-scope keeps a viewer's
 * own tasks) and the requests assigned to them.
 */
export async function unitCategoryIdsFor(admin: Admin, me: Pick<CurrentUser, 'isAdmin' | 'employeeId'> | null): Promise<string[] | null> {
  if (!me || me.isAdmin || !me.employeeId) return null
  const units = await unitsOfEmployee(admin, me.employeeId)
  if (!units.length) return null
  return [...new Set(units.filter(u => u.role !== 'staff').flatMap(u => u.categoryIds))]
}

/** Everyone on the same unit(s) as this member — for team pickers and boards. */
export async function unitTeamIds(admin: Admin, me: Pick<CurrentUser, 'isAdmin' | 'employeeId'> | null): Promise<Set<string> | null> {
  if (!me || me.isAdmin || !me.employeeId) return null
  const units = await unitsOfEmployee(admin, me.employeeId)
  if (!units.length) return null
  const { data, error } = await admin.from('business_unit_members').select('employee_id').in('unit_id', units.map(u => u.id))
  if (error) throw new Error(`Could not read the unit team: ${error.message}`)
  return new Set([me.employeeId, ...((data ?? []) as { employee_id: string }[]).map(r => r.employee_id)])
}

/**
 * Cirqle's office team (Departments & Brands → Cirqle HQ → Office team), or
 * null while its migration has not been run. Unit lines in chat do not stand
 * between a unit's team and the office team.
 */
export async function loadOfficeIds(admin: Admin): Promise<Set<string> | null> {
  const { data, error } = await admin.from('business_unit_office_staff').select('employee_id')
  if (error) {
    if (notInstalled(error)) return null
    throw new Error(`Could not read the office team: ${error.message}`)
  }
  return new Set(((data ?? []) as { employee_id: string }[]).map(r => r.employee_id))
}
