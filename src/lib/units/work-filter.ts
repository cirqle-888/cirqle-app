import 'server-only'

/**
 * The unit work filter — for pages a unit team may open whose rows are not
 * already narrowed by the service scope (Requests, Social Calendar).
 *
 * null = the viewer is not confined to a unit (admins, the office team):
 * the page shows what it always showed. Otherwise a row is kept when it is on
 * one of the unit's services, or — when it names no service — belongs to one
 * of the unit's clients.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CurrentUser } from '@/lib/permissions/check'
import { confinedScope } from '@/lib/brands/restriction'
import { loadDepartmentClientScope } from '@/lib/scope/department-clients'
import { isUnitConfined } from './membership'

export interface UnitWorkFilter {
  serviceIds: Set<string>
  clientIds: Set<string>
  /** Does the unit run Offer Flyers? Offer campaigns are that department's work. */
  coversOfferFlyers: boolean
}

export async function unitWorkFilter(admin: SupabaseClient, me: CurrentUser | null): Promise<UnitWorkFilter | null> {
  if (!(await isUnitConfined(admin, me))) return null
  const [confined, clients, offer] = await Promise.all([
    confinedScope(admin, me),
    loadDepartmentClientScope(admin, me),
    admin.from('service_categories').select('id').eq('slug', 'offer-flyers').maybeSingle(),
  ])
  const offerId = (offer.data as { id?: string } | null)?.id
  return {
    coversOfferFlyers: !!offerId && !!confined?.categoryIds.has(offerId),
    serviceIds: confined?.serviceIds ?? new Set(),
    // A failed client read would come back unrestricted — for a unit member
    // that must mean "no clients", never "every client".
    clientIds: clients.restricted ? clients.clientIds : new Set(),
  }
}

/** Is a row inside the unit? Rows with a service go by the service; the rest by client. */
export function inUnitWork(f: UnitWorkFilter, row: { serviceId?: string | null; clientId?: string | null }): boolean {
  if (row.serviceId) return f.serviceIds.has(row.serviceId)
  return !!row.clientId && f.clientIds.has(row.clientId)
}
