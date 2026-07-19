/**
 * Service Scoping — client-safe helpers.
 *
 * Deliberately imports NOTHING server-side (no admin client, no permissions
 * module), so client components can use it without pulling the service-role
 * client into the browser bundle. Server code builds the payload with
 * toServiceScopePayload(); this file consumes it.
 */

import type { ServiceScopePayload } from './service-scope'

export type { ServiceScopePayload }

/** An empty payload — the unrestricted default before scope is wired to a page. */
export const UNSCOPED_PAYLOAD: ServiceScopePayload = {
  mode: 'legacy',
  restricted: false,
  serviceIds: [],
  clientServices: {},
  clientNarrowingEnabled: false,
}

/**
 * Services a client is committed to. `null` = do not narrow (no client chosen,
 * narrowing off, or the client has nothing recorded). Never returns an empty
 * set — an empty picker is a dead end.
 */
export function committedServicesFor(
  payload: ServiceScopePayload | null | undefined,
  clientId: string | null | undefined,
): Set<string> | null {
  if (!payload?.clientNarrowingEnabled || !clientId) return null
  const ids = payload.clientServices[clientId]
  if (!ids || ids.length === 0) return null
  return new Set(ids)
}

export function isCommitted(
  payload: ServiceScopePayload | null | undefined,
  clientId: string | null | undefined,
  serviceId: string | null | undefined,
): boolean {
  if (!serviceId) return true
  const committed = committedServicesFor(payload, clientId)
  return committed === null || committed.has(serviceId)
}

/** Services assigned to the viewer, when restricted. `null` = unrestricted. */
export function assignedServicesFor(
  payload: ServiceScopePayload | null | undefined,
): Set<string> | null {
  if (!payload?.restricted || payload.serviceIds.length === 0) return null
  return new Set(payload.serviceIds)
}

export interface ServiceOption { id: string; name: string }

export interface NarrowedServices<T extends ServiceOption> {
  /** What the picker shows. */
  options: T[]
  /** Committed-but-hidden count, for the "+ other service" affordance. */
  hiddenCount: number
  /** True when narrowing actually removed something (drives the escape hatch). */
  narrowed: boolean
  /** True when the current selection is outside the client's committed set. */
  selectionOutsidePlan: boolean
}

/**
 * Narrow a service list for a chosen client.
 *
 * Invariants, in order of importance:
 *  1. `selectedId` is ALWAYS present in options — a scoping rule must never
 *     make a saved record unsavable.
 *  2. Employee restriction and client commitment compose (both apply).
 *  3. If narrowing would empty the list, fall back to the full list. Callers
 *     surface `narrowed`/`hiddenCount` rather than showing an empty dropdown.
 */
export function narrowServiceOptions<T extends ServiceOption>(
  all: T[],
  payload: ServiceScopePayload | null | undefined,
  clientId: string | null | undefined,
  selectedId?: string | null,
  opts: { showAll?: boolean } = {},
): NarrowedServices<T> {
  const assigned = assignedServicesFor(payload)
  const committed = committedServicesFor(payload, clientId)

  const byAssignment = assigned ? all.filter(s => s.id === selectedId || assigned.has(s.id)) : all

  if (opts.showAll || committed === null) {
    return {
      options: byAssignment,
      hiddenCount: all.length - byAssignment.length,
      narrowed: byAssignment.length < all.length,
      selectionOutsidePlan: false,
    }
  }

  const narrowedList = byAssignment.filter(s => committed.has(s.id) || s.id === selectedId)
  const selectionOutsidePlan = !!selectedId && !committed.has(selectedId)

  // Never hand back an empty picker.
  if (narrowedList.length === 0) {
    return {
      options: byAssignment,
      hiddenCount: 0,
      narrowed: false,
      selectionOutsidePlan,
    }
  }

  return {
    options: narrowedList,
    hiddenCount: byAssignment.length - narrowedList.length,
    narrowed: narrowedList.length < byAssignment.length,
    selectionOutsidePlan,
  }
}
