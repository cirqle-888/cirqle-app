/**
 * Org-unit scoping — "my department / team / branch / region only".
 *
 * The third visibility dimension, sitting beside the existing two:
 *
 *   own      — just me                    (contributions.view_own)
 *   UNIT     — my org unit and everything beneath it   ← this module
 *   all      — the whole company          (contributions.view_all)
 *
 * A viewer's unit set is every unit they are a member of PLUS every unit
 * beneath those, so a branch manager automatically covers the teams inside the
 * branch and keeps covering a team added later — the same inheritance
 * src/lib/org/units.ts already gives the money engines.
 *
 * Two things are in a unit's view, OR-ed:
 *
 *   PEOPLE  — everyone who is a member of any unit in the set. This is what
 *             scopes contribution rows: a colleague's score is visible only if
 *             they are in your unit subtree.
 *   REVENUE — the client / service / service-category mappings on those units
 *             (org_unit_scopes). This is what scopes TASKS: a branch mapped to
 *             "client A" sees client A's tasks even before anyone is assigned.
 *
 * Conventions match src/lib/scope/service-scope.ts: server-only, pure
 * post-fetch filters that never mutate their input and return the original
 * array untouched when the viewer is unrestricted.
 *
 * NOTHING HERE TOUCHES THE CONTRIBUTION ENGINE. Like org units generally, this
 * is a visibility lens only — never a task's pool, scoring or earnings.
 */

import { PERMS } from '@/lib/permissions/keys'
import { hasPermission, type CurrentUser } from '@/lib/permissions/check'
import {
  descendantUnitIds, loadOrgGraph, loadOrgMembers,
  type OrgUnit, type OrgUnitScopeRow, type OrgMember,
} from '@/lib/org/units'
import type { createAdminClient } from '@/lib/supabase/admin'

type Admin = ReturnType<typeof createAdminClient>

/**
 *   'all'    — admin, scope.view_all, or the module's own view_all key
 *   'unit'   — restricted / widened to the viewer's org unit subtree
 *   'legacy' — neither key held: behaviour is exactly what it was before
 */
export type UnitScopeMode = 'all' | 'unit' | 'legacy'

/** Modules keep their own key so a role can be unit-scoped on one, not the other. */
export type UnitScopeModule = 'tasks' | 'contributions' | 'global'

export interface UnitScope {
  mode: UnitScopeMode
  employeeId: string | null
  /** The viewer's units + all descendants. Empty unless mode === 'unit'. */
  unitIds: Set<string>
  /** Every employee in those units, including the viewer. */
  memberEmployeeIds: Set<string>
  /** Revenue mapped to those units — three OR-ed axes, any may be empty. */
  clientIds: Set<string>
  serviceIds: Set<string>
  categoryIds: Set<string>
  /** True when the unit subtree maps any revenue at all (see scopeTasksByUnit). */
  hasRevenueMapping: boolean
}

const EMPTY: Omit<UnitScope, 'mode' | 'employeeId'> = {
  unitIds: new Set(), memberEmployeeIds: new Set(),
  clientIds: new Set(), serviceIds: new Set(), categoryIds: new Set(),
  hasRevenueMapping: false,
}

// ── Mode resolution ──────────────────────────────────────────────────────────

/**
 * Uses hasPermission, NOT strip.ts's userCanSee: userCanSee returns true for a
 * null user, which on a scoping key would silently change what an
 * unauthenticated render shows. Absent a user we report 'all' explicitly, the
 * same fail-open every other loader on these pages takes.
 */
export function resolveUnitScopeMode(
  me: CurrentUser | null,
  module: UnitScopeModule = 'global',
): UnitScopeMode {
  if (!me) return 'all'
  if (me.isAdmin) return 'all'
  if (hasPermission(me, PERMS.SCOPE_VIEW_ALL)) return 'all'
  if (module === 'tasks' && hasPermission(me, PERMS.TASKS_VIEW_ALL)) return 'all'
  if (module === 'contributions' && hasPermission(me, PERMS.CONTRIBUTIONS_VIEW_ALL)) return 'all'

  if (hasPermission(me, PERMS.SCOPE_BY_UNIT)) return 'unit'
  if (module === 'tasks' && hasPermission(me, PERMS.TASKS_VIEW_BY_UNIT)) return 'unit'
  if (module === 'contributions' && hasPermission(me, PERMS.CONTRIBUTIONS_VIEW_UNIT)) return 'unit'
  return 'legacy'
}

// ── Pure resolution (testable without a DB) ──────────────────────────────────

/** Units the employee belongs to, plus everything beneath each of them. */
export function unitSubtreeFor(
  units: OrgUnit[],
  members: OrgMember[],
  employeeId: string,
): Set<string> {
  const out = new Set<string>()
  for (const m of members) {
    if (m.employeeId !== employeeId) continue
    for (const id of descendantUnitIds(units, m.unitId)) out.add(id)
  }
  return out
}

/** Build the scope from an already-loaded org graph. Pure. */
export function buildUnitScope(
  mode: UnitScopeMode,
  employeeId: string | null,
  units: OrgUnit[],
  members: OrgMember[],
  scopes: OrgUnitScopeRow[],
): UnitScope {
  if (mode !== 'unit' || !employeeId) return { mode, employeeId, ...EMPTY }

  const unitIds = unitSubtreeFor(units, members, employeeId)

  // The viewer is always in their own view, even when they belong to no unit
  // at all — otherwise granting the key would hide a person's own work.
  const memberEmployeeIds = new Set<string>([employeeId])
  for (const m of members) if (unitIds.has(m.unitId)) memberEmployeeIds.add(m.employeeId)

  const clientIds = new Set<string>()
  const serviceIds = new Set<string>()
  const categoryIds = new Set<string>()
  for (const s of scopes) {
    if (!unitIds.has(s.unitId)) continue
    if (s.clientId) clientIds.add(s.clientId)
    if (s.serviceId) serviceIds.add(s.serviceId)
    if (s.serviceCategoryId) categoryIds.add(s.serviceCategoryId)
  }

  return {
    mode, employeeId, unitIds, memberEmployeeIds,
    clientIds, serviceIds, categoryIds,
    hasRevenueMapping: clientIds.size + serviceIds.size + categoryIds.size > 0,
  }
}

// ── Loading ──────────────────────────────────────────────────────────────────

/**
 * Load the org graph and resolve the viewer's unit scope, once per request.
 *
 * Costs nothing for the overwhelming majority of viewers: unrestricted modes
 * short-circuit before any query. Not cached, for the same reason
 * loadServiceScope isn't — loadCurrentUser's 30s cache has no invalidation
 * hook, so a re-assigned employee would keep the old unit's visibility.
 *
 * loadOrgGraph/loadOrgMembers already swallow a missing table (pre-migration)
 * and return empty structures, which resolve to "member of nothing".
 */
export async function loadUnitScope(
  admin: Admin,
  me: CurrentUser | null,
  module: UnitScopeModule = 'global',
): Promise<UnitScope> {
  const mode = resolveUnitScopeMode(me, module)
  const employeeId = me?.employeeId ?? null
  if (mode !== 'unit' || !employeeId) return { mode, employeeId, ...EMPTY }

  const [{ units, scopes }, members] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loadOrgGraph(admin as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loadOrgMembers(admin as any),
  ])
  const scope = buildUnitScope(mode, employeeId, units, members, scopes)

  // Expand category mappings into the services they contain, so callers only
  // ever match on client_id / service_id — the two columns tasks actually
  // carry. Resolved at READ time for the same reason employee_service_categories
  // is (see service-scope.ts): a service added to a category later is picked up
  // with no re-mapping. A failed read leaves the category axis unexpanded,
  // which under-scopes rather than blanks the page.
  if (scope.categoryIds.size > 0) {
    const { data } = await admin
      .from('services').select('id').in('category_id', [...scope.categoryIds])
    for (const r of ((data || []) as { id: string }[])) scope.serviceIds.add(r.id)
    scope.hasRevenueMapping =
      scope.clientIds.size + scope.serviceIds.size + scope.categoryIds.size > 0
  }

  return scope
}

// ── Restriction active? ──────────────────────────────────────────────────────

/**
 * True when the viewer is unit-scoped. Note there is NO "belongs to no unit →
 * see everything" escape hatch here, unlike service scoping.
 *
 * The two keys pull in opposite directions and both land on the pre-existing
 * behaviour when the org chart isn't configured yet:
 *
 *   contributions.view_unit WIDENS from own → unit. An unmapped holder falls
 *   back to their own rows, which is what they had before the grant.
 *   tasks.view_by_unit NARROWS from all → unit. An unmapped holder would see
 *   nothing, so scopeTasksByUnit explicitly passes them through (see there).
 */
export function isUnitScoped(scope: UnitScope): boolean {
  return scope.mode === 'unit'
}

// ── Pure filters ─────────────────────────────────────────────────────────────

/**
 * Keep only rows belonging to an employee inside the viewer's unit subtree.
 * Drives the contributions strip — the same shape as that page's `mine()`,
 * widened from one id to the unit's roster.
 */
export function scopeRowsByUnitMember<T>(
  rows: T[],
  scope: UnitScope,
  pick: (row: T) => string | null | undefined,
): T[] {
  if (!isUnitScoped(scope)) return rows
  return rows.filter(row => {
    const employeeId = pick(row)
    return employeeId != null && scope.memberEmployeeIds.has(employeeId)
  })
}

/**
 * Filter tasks to the unit's revenue, keeping anything the viewer or their
 * unit-mates personally worked on.
 *
 * FAILS OPEN on an unmapped unit subtree, the inverse of matchesScope() in
 * src/lib/org/units.ts — and deliberately so. There, a unit that owns no
 * revenue must own none, or a half-configured branch pays its manager a cut of
 * the whole company. Here the same emptiness means "the org chart has no
 * mappings yet", and fail-closed would blank the task board of everyone
 * holding the key the moment it is granted. Money fails closed; visibility of
 * one's own work does not.
 */
export function scopeTasksByUnit<T>(
  tasks: T[],
  scope: UnitScope,
  pick: {
    id: (task: T) => string | null | undefined
    clientId: (task: T) => string | null | undefined
    /** Category mappings are already expanded into services by loadUnitScope. */
    serviceId: (task: T) => string | null | undefined
  },
  unitTaskIds: Iterable<string> = [],
): T[] {
  if (!isUnitScoped(scope)) return tasks
  if (!scope.hasRevenueMapping) return tasks          // see the note above
  const own = new Set(unitTaskIds)
  return tasks.filter(t => {
    const id = pick.id(t)
    if (id != null && own.has(id)) return true
    const clientId = pick.clientId(t)
    if (clientId && scope.clientIds.has(clientId)) return true
    const serviceId = pick.serviceId(t)
    if (serviceId && scope.serviceIds.has(serviceId)) return true
    return false
  })
}

/** Task ids anyone in the viewer's unit has history on. Pure; callers pass the
 *  assignment / score / contribution rows they already fetched. */
export function unitTaskIdsFrom(
  scope: UnitScope,
  rowSets: { task_id?: string | null; employee_id?: string | null }[][],
): Set<string> {
  const out = new Set<string>()
  if (!isUnitScoped(scope)) return out
  for (const rows of rowSets) {
    for (const r of rows) {
      if (r?.task_id && r.employee_id && scope.memberEmployeeIds.has(r.employee_id)) out.add(r.task_id)
    }
  }
  return out
}
