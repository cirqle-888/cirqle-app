/**
 * Organization units — the scope resolver.
 *
 * One typed, self-nesting table covers departments, teams, branches, regions
 * and client groups. This module answers the only question the money engines
 * ask of it: **which revenue does this unit own?**
 *
 * A unit's scope is the union of its own mappings and those of every unit
 * beneath it, so "Branch Kochi" automatically includes the teams inside it —
 * that inheritance is what makes a branch-level rule keep working when a team
 * is added under it, with no reconfiguration.
 *
 * NOTHING HERE TOUCHES THE CONTRIBUTION ENGINE. Units are a lens for
 * aggregating revenue and attributing ownership rewards; they never affect a
 * task's pool, scoring or an employee's contribution earnings.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type OrgUnitType = 'department' | 'team' | 'branch' | 'region' | 'client_group'

export const ORG_UNIT_TYPES: readonly OrgUnitType[] =
  ['department', 'team', 'branch', 'region', 'client_group'] as const

export const ORG_UNIT_TYPE_LABEL: Record<OrgUnitType, string> = {
  department: 'Department',
  team: 'Team',
  branch: 'Branch',
  region: 'Region',
  client_group: 'Client Group',
}

export interface OrgUnit {
  id: string
  name: string
  type: OrgUnitType
  parentId: string | null
  isActive: boolean
}

export interface OrgUnitScopeRow {
  unitId: string
  clientId: string | null
  serviceCategoryId: string | null
  serviceId: string | null
}

/** The revenue a unit owns, flattened. Empty sets mean "no filter on this axis". */
export interface ResolvedScope {
  clientIds: Set<string>
  categoryIds: Set<string>
  serviceIds: Set<string>
  /** False when the unit maps nothing — callers must treat it as matching NO
   *  revenue rather than ALL revenue (see matchesScope). */
  hasAnyMapping: boolean
}

/**
 * Every unit at or beneath `rootId`.
 *
 * Cycle-safe: a `seen` set means a malformed parent chain degrades to a
 * partial answer instead of hanging the request. The DB blocks self-parenting
 * but not longer loops, and an infinite loop inside a payroll computation is
 * the worst possible failure mode.
 */
export function descendantUnitIds(units: OrgUnit[], rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const u of units) {
    if (!u.parentId) continue
    const list = childrenOf.get(u.parentId) ?? []
    list.push(u.id)
    childrenOf.set(u.parentId, list)
  }
  const out = new Set<string>()
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()!
    if (out.has(id)) continue          // cycle guard
    out.add(id)
    for (const child of childrenOf.get(id) ?? []) stack.push(child)
  }
  return out
}

/** Flatten a unit subtree's mappings into the three axes. Pure. */
export function resolveScope(
  units: OrgUnit[],
  scopes: OrgUnitScopeRow[],
  rootId: string,
): ResolvedScope {
  const ids = descendantUnitIds(units, rootId)
  const clientIds = new Set<string>()
  const categoryIds = new Set<string>()
  const serviceIds = new Set<string>()
  for (const s of scopes) {
    if (!ids.has(s.unitId)) continue
    if (s.clientId) clientIds.add(s.clientId)
    if (s.serviceCategoryId) categoryIds.add(s.serviceCategoryId)
    if (s.serviceId) serviceIds.add(s.serviceId)
  }
  return {
    clientIds, categoryIds, serviceIds,
    hasAnyMapping: clientIds.size + categoryIds.size + serviceIds.size > 0,
  }
}

/**
 * Does this task's revenue belong to the unit?
 *
 * Axes are OR-ed: a unit mapped to "client A" and "Video" owns everything for
 * client A plus all Video work, which is how a branch that both serves
 * specific clients and runs a specific discipline is expressed.
 *
 * FAILS CLOSED on an unmapped unit. A unit with no scope rows owns NO revenue,
 * never all of it — the opposite default would make a half-configured branch
 * silently pay its manager a percentage of the entire company.
 */
export function matchesScope(
  scope: ResolvedScope,
  task: { clientId: string | null; serviceId: string | null; serviceCategoryId: string | null },
): boolean {
  if (!scope.hasAnyMapping) return false
  if (task.clientId && scope.clientIds.has(task.clientId)) return true
  if (task.serviceId && scope.serviceIds.has(task.serviceId)) return true
  if (task.serviceCategoryId && scope.categoryIds.has(task.serviceCategoryId)) return true
  return false
}

// ── IO ───────────────────────────────────────────────────────────────────────

/**
 * Load the org graph. Returns empty structures when the tables are absent
 * (pre-migration), so every caller degrades to "no units configured" rather
 * than failing.
 */
export async function loadOrgGraph(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
): Promise<{ units: OrgUnit[]; scopes: OrgUnitScopeRow[] }> {
  try {
    const [u, s] = await Promise.all([
      admin.from('org_units').select('id, name, type, parent_id, is_active').order('display_order').order('name'),
      admin.from('org_unit_scopes').select('unit_id, client_id, service_category_id, service_id'),
    ])
    if (u.error || s.error) return { units: [], scopes: [] }
    return {
      units: (u.data || []).map((r: Record<string, unknown>) => ({
        id: r.id as string,
        name: r.name as string,
        type: (r.type as OrgUnitType) ?? 'team',
        parentId: (r.parent_id as string) ?? null,
        isActive: r.is_active !== false,
      })),
      scopes: (s.data || []).map((r: Record<string, unknown>) => ({
        unitId: r.unit_id as string,
        clientId: (r.client_id as string) ?? null,
        serviceCategoryId: (r.service_category_id as string) ?? null,
        serviceId: (r.service_id as string) ?? null,
      })),
    }
  } catch {
    return { units: [], scopes: [] }
  }
}

export interface OrgMember {
  unitId: string
  employeeId: string
  isManager: boolean
  roleLabel: string | null
}

/** Unit membership. Multiple managers per unit are expected, never assumed away. */
export async function loadOrgMembers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
): Promise<OrgMember[]> {
  try {
    const { data, error } = await admin
      .from('org_unit_members')
      .select('unit_id, employee_id, is_manager, role_label')
    if (error) return []
    return (data || []).map((r: Record<string, unknown>) => ({
      unitId: r.unit_id as string,
      employeeId: r.employee_id as string,
      isManager: r.is_manager === true,
      roleLabel: (r.role_label as string) ?? null,
    }))
  } catch {
    return []
  }
}
