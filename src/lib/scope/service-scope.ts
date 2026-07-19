/**
 * Service Scoping — the shared resolution layer (server-only).
 *
 * Two independent filters, one data layer:
 *
 *   A. EMPLOYEE scope — an employee restricted to their assigned services sees
 *      only those services, and only the clients who buy them. Opt-in per
 *      designation via `scope.by_service`; inert until granted.
 *
 *   B. CLIENT commitment — picking a client narrows the service picker to what
 *      that client is actually committed to. Not permission-based; it is data
 *      correctness, and applies to admins too.
 *
 * Conventions mirror src/lib/permissions/strip.ts: pure post-fetch filters that
 * never mutate their input and early-return the original array when the viewer
 * is unrestricted, so the 'legacy' path is a byte-identical passthrough.
 *
 * NAMING: everything here is ServiceScope*. Do not shorten to Scope* —
 * src/lib/finance/classify.ts already owns `FinanceScope` ('client'|'company')
 * and SCOPE_LABELS for an unrelated concept.
 */

import { PERMS } from '@/lib/permissions/keys'
import { hasPermission, type CurrentUser } from '@/lib/permissions/check'
import type { createAdminClient } from '@/lib/supabase/admin'

type Admin = ReturnType<typeof createAdminClient>

/**
 *   'all'      — admin, `scope.view_all`, or (on tasks) `tasks.view_all`
 *   'services' — restricted to assigned services
 *   'legacy'   — neither: unchanged historical behaviour, everything visible
 */
export type ServiceScopeMode = 'all' | 'services' | 'legacy'

/** Modules keep their own legacy keys working while the rollout is partial. */
export type ServiceScopeModule = 'tasks' | 'contributions' | 'global'

export interface ServiceScope {
  mode: ServiceScopeMode
  employeeId: string | null
  /** Services assigned to the viewer. Empty unless mode === 'services'. */
  serviceIds: Set<string>
  /** clientId → committed serviceIds. Full map; feature B needs every client. */
  clientServices: Map<string, Set<string>>
  /** Clients with ≥1 committed service ∩ serviceIds. Empty unless 'services'. */
  visibleClientIds: Set<string>
  /** Clients with NO commitment rows — "not set up yet", not "buys nothing". */
  unconfiguredClientIds: Set<string>
  /** False when the client→service narrowing kill switch is off. */
  clientNarrowingEnabled: boolean
}

// ── Mode resolution ──────────────────────────────────────────────────────────

/**
 * Deliberately uses hasPermission, NOT strip.ts's userCanSee: the latter
 * returns true for a null user, which on a RESTRICTION key would restrict
 * everyone the moment auth hiccups — the exact inverse of the intent.
 */
export function resolveServiceScopeMode(
  me: CurrentUser | null,
  module: ServiceScopeModule = 'global',
): ServiceScopeMode {
  if (!me) return 'all'                       // fail-open, matches every other loader
  if (me.isAdmin) return 'all'
  if (hasPermission(me, PERMS.SCOPE_VIEW_ALL)) return 'all'
  if (module === 'tasks' && hasPermission(me, PERMS.TASKS_VIEW_ALL)) return 'all'

  if (hasPermission(me, PERMS.SCOPE_BY_SERVICE)) return 'services'
  if (module === 'tasks' && hasPermission(me, PERMS.TASKS_VIEW_BY_SERVICE)) return 'services'
  return 'legacy'
}

// ── Loading ──────────────────────────────────────────────────────────────────

/** Service ids assigned to an employee. `null` signals a READ FAILURE. */
async function fetchAssignedServiceIds(admin: Admin, employeeId: string): Promise<string[] | null> {
  const { data, error } = await admin
    .from('employee_services').select('service_id').eq('employee_id', employeeId)
  if (error) return null                       // distinct from "assigned nothing"
  return (data || []).map((r: { service_id: string }) => r.service_id)
}

async function fetchClientNarrowingEnabled(admin: Admin): Promise<boolean> {
  try {
    const { data } = await admin.from('company_settings')
      .select('value').eq('key', 'scope_client_services').maybeSingle()
    return (data as { value?: string } | null)?.value !== 'off'
  } catch { return true }                      // unset → on
}

/**
 * Load everything needed to scope any list, once per request.
 *
 * NOT cached: loadCurrentUser's 30s process cache has no invalidation hook, so
 * caching scope there would leave a reassigned employee holding old access.
 * These are two small indexed queries.
 */
export async function loadServiceScope(
  admin: Admin,
  me: CurrentUser | null,
  module: ServiceScopeModule = 'global',
): Promise<ServiceScope> {
  let mode = resolveServiceScopeMode(me, module)
  const employeeId = me?.employeeId ?? null

  const [assigned, narrowing, commitments] = await Promise.all([
    mode === 'services' && employeeId
      ? fetchAssignedServiceIds(admin, employeeId)
      : Promise.resolve<string[] | null>([]),
    fetchClientNarrowingEnabled(admin),
    admin.from('client_service_pricing')
      .select('client_id, service_id')
      .eq('is_active', true)
      .then(r => (r.error ? null : (r.data || []))),
  ])

  // A failed read must not masquerade as "assigned to nothing" — that would
  // blank a restricted user's entire app. Degrade to unrestricted instead.
  if (assigned === null) mode = 'legacy'

  const serviceIds = new Set<string>(mode === 'services' ? (assigned ?? []) : [])

  const clientServices = new Map<string, Set<string>>()
  for (const row of (commitments ?? []) as { client_id: string | null; service_id: string | null }[]) {
    if (!row.client_id || !row.service_id) continue
    const set = clientServices.get(row.client_id)
    if (set) set.add(row.service_id)
    else clientServices.set(row.client_id, new Set([row.service_id]))
  }

  const visibleClientIds = new Set<string>()
  if (mode === 'services' && serviceIds.size > 0) {
    for (const [clientId, svc] of clientServices) {
      for (const id of svc) { if (serviceIds.has(id)) { visibleClientIds.add(clientId); break } }
    }
  }

  return {
    mode,
    employeeId,
    serviceIds,
    clientServices,
    visibleClientIds,
    unconfiguredClientIds: new Set(),  // filled by callers that know the client universe
    clientNarrowingEnabled: narrowing && commitments !== null,
  }
}

/**
 * Mark which of the known clients have no commitments at all. Callers pass the
 * client list they already fetched, so this costs no extra query.
 */
export function markUnconfiguredClients(scope: ServiceScope, clientIds: Iterable<string>): ServiceScope {
  for (const id of clientIds) if (!scope.clientServices.has(id)) scope.unconfiguredClientIds.add(id)
  return scope
}

// ── Restriction active? ──────────────────────────────────────────────────────

/**
 * True only when the viewer is genuinely restricted AND has assignments.
 *
 * An employee with zero assigned services sees EVERYTHING (product decision):
 * a half-configured rollout must never lock anyone out. The Settings health
 * panel surfaces these people so the restriction can't be silently useless.
 */
export function isServiceRestricted(scope: ServiceScope): boolean {
  return scope.mode === 'services' && scope.serviceIds.size > 0
}

// ── Pure filters (feature A) ─────────────────────────────────────────────────

export function scopeServiceList<T extends { id: string }>(rows: T[], scope: ServiceScope): T[] {
  if (!isServiceRestricted(scope)) return rows
  return rows.filter(r => scope.serviceIds.has(r.id))
}

export function scopeClientList<T extends { id: string }>(rows: T[], scope: ServiceScope): T[] {
  if (!isServiceRestricted(scope)) return rows
  // Unconfigured clients stay visible — no commitments means "not set up yet",
  // and hiding them would make them invisible AND unfixable.
  return rows.filter(r => scope.visibleClientIds.has(r.id) || scope.unconfiguredClientIds.has(r.id))
}

/**
 * Filter arbitrary rows by the service they belong to.
 * `pick` keeps this dimension-agnostic — a future branch/department scope
 * reuses it unchanged. `keep` preserves rows the viewer has history on.
 */
export function scopeRowsByService<T>(
  rows: T[],
  scope: ServiceScope,
  pick: (row: T) => string | null | undefined,
  keep: { ids?: Iterable<string>; id?: (row: T) => string | null | undefined } = {},
): T[] {
  if (!isServiceRestricted(scope)) return rows
  const keepIds = new Set(keep.ids ?? [])
  return rows.filter(row => {
    const serviceId = pick(row)
    if (serviceId == null) return true                    // unclassified work stays visible
    if (scope.serviceIds.has(serviceId)) return true
    const ownId = keep.id?.(row)
    return ownId != null && keepIds.has(ownId)
  })
}

export function scopeRowsByClient<T>(
  rows: T[],
  scope: ServiceScope,
  pick: (row: T) => string | null | undefined,
  keep: { ids?: Iterable<string>; id?: (row: T) => string | null | undefined } = {},
): T[] {
  if (!isServiceRestricted(scope)) return rows
  const keepIds = new Set(keep.ids ?? [])
  return rows.filter(row => {
    const clientId = pick(row)
    if (clientId == null) return true                     // internal Cirqle work
    if (scope.visibleClientIds.has(clientId) || scope.unconfiguredClientIds.has(clientId)) return true
    const ownId = keep.id?.(row)
    return ownId != null && keepIds.has(ownId)
  })
}

// ── Feature B: client → committed services ───────────────────────────────────

/**
 * Services a client is committed to.
 *
 * Returns `null` meaning DO NOT NARROW — no client selected, narrowing
 * disabled, or the client has no commitments recorded. That is deliberately
 * distinct from an empty Set (narrow to nothing), which this never returns:
 * an empty picker is a dead end.
 */
export function committedServiceIds(
  clientId: string | null | undefined,
  scope: ServiceScope,
): Set<string> | null {
  if (!clientId || !scope.clientNarrowingEnabled) return null
  const committed = scope.clientServices.get(clientId)
  if (!committed || committed.size === 0) return null
  return committed
}

// ── RSC boundary ─────────────────────────────────────────────────────────────

export interface ServiceScopePayload {
  mode: ServiceScopeMode
  restricted: boolean
  serviceIds: string[]
  clientServices: Record<string, string[]>
  clientNarrowingEnabled: boolean
}

/**
 * Serialise for client components. Only ids cross the boundary — no prices,
 * so this is safe to send to viewers without `tasks.view_pricing`.
 */
export function toServiceScopePayload(scope: ServiceScope): ServiceScopePayload {
  const clientServices: Record<string, string[]> = {}
  for (const [clientId, set] of scope.clientServices) clientServices[clientId] = [...set]
  return {
    mode: scope.mode,
    restricted: isServiceRestricted(scope),
    serviceIds: [...scope.serviceIds],
    clientServices,
    clientNarrowingEnabled: scope.clientNarrowingEnabled,
  }
}
