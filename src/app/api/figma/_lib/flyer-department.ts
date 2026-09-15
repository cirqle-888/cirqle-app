import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The offer-flyer department: which clients and which services a flyer tool
 * is allowed to file work against.
 *
 * "Department" is the service CATEGORY — the org has no separate department
 * dimension, and category is the proxy the rest of the app uses. The category
 * is found by name, and the name is editable from Settings → Services by
 * anyone who can rename a category. That used to be an invisible dependency:
 * rename "Offer Flyers" and the client dropdown silently widened to every
 * client in the workspace, with nothing anywhere saying why.
 *
 * Two changes make that survivable:
 *   1. `company_settings.offer_flyer_category` overrides the name, so a
 *      workspace that renames the category can point the tools at it without
 *      a deployment.
 *   2. Every answer carries `matched` and `reason`, so a caller can SAY it
 *      fell back instead of quietly showing the wrong list. /api/figma/offers
 *      passes it through; Offer Studio's health check surfaces it.
 *
 * Still fails open, deliberately: a slightly-too-long client list is a
 * papercut, an empty one means nobody can save a flyer at all.
 */

/** The category name used when the workspace has not overridden it. */
export const DEFAULT_OFFER_FLYER_CATEGORY = 'Offer Flyers'

/** The service every flyer is unless someone says otherwise. */
export const DEFAULT_FLYER_SERVICE_NAME = 'Offer Flyer'

export interface FlyerService {
  id: string
  name: string
  /** True for the one service a flyer defaults to (`Offer Flyer`). */
  isDefault?: boolean
}

export interface FlyerDepartment {
  categoryName: string
  /** Service ids in the department, empty when the category was not found. */
  serviceIds: string[]
  services: FlyerService[]
  /** The `Offer Flyer` service id, when the department has one. */
  defaultServiceId: string | null
  /** False when the category could not be resolved and callers must fail open. */
  matched: boolean
  /** Plain-language explanation, safe to show a person. */
  reason: string
}

/** The category name this workspace uses, from settings or the default. */
export async function offerFlyerCategoryName(admin: SupabaseClient): Promise<string> {
  try {
    const { data } = await admin
      .from('company_settings')
      .select('value')
      .eq('key', 'offer_flyer_category')
      .maybeSingle()
    const configured = ((data as { value?: string } | null)?.value || '').trim()
    return configured || DEFAULT_OFFER_FLYER_CATEGORY
  } catch {
    return DEFAULT_OFFER_FLYER_CATEGORY
  }
}

/**
 * The department's services, in display order, with the default flagged.
 *
 * Scoped to the category on purpose. The tools used to receive every active
 * service in the workspace — all 33 — so a designer filing a supermarket
 * flyer could pick "Video Editing" from the dropdown. The five that belong
 * here (Offer Flyer, A3 Offer Flyer, Offer Flyer Updating, Revised Offer
 * Flyer, Extra Design on Offer Flyer) are the whole of the real answer.
 */
export async function offerFlyerDepartment(admin: SupabaseClient): Promise<FlyerDepartment> {
  const categoryName = await offerFlyerCategoryName(admin)
  const unmatched = (reason: string): FlyerDepartment => ({
    categoryName, serviceIds: [], services: [], defaultServiceId: null, matched: false, reason,
  })

  try {
    const { data: cats } = await admin
      .from('service_categories')
      .select('id')
      .eq('name', categoryName)
    const categoryIds = ((cats as { id: string }[] | null) || []).map(c => c.id)
    if (!categoryIds.length) {
      return unmatched(
        `No service category named "${categoryName}". Showing every service and client. ` +
        `Rename the category back, or set company_settings.offer_flyer_category to its new name.`,
      )
    }

    const { data: svc } = await admin
      .from('services')
      .select('id, name')
      .eq('is_active', true)
      .in('category_id', categoryIds)
      .order('display_order')
      .order('name')
    const rows = ((svc as { id: string; name: string | null }[] | null) || [])
      .map(s => ({ id: s.id, name: s.name || '' }))
    if (!rows.length) {
      return unmatched(`The "${categoryName}" category has no active services. Showing every service and client.`)
    }

    const flat = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
    const wanted = flat(DEFAULT_FLYER_SERVICE_NAME)
    const defaultServiceId = rows.find(s => flat(s.name) === wanted)?.id || null

    return {
      categoryName,
      serviceIds: rows.map(s => s.id),
      services: rows.map(s => ({ id: s.id, name: s.name, isDefault: s.id === defaultServiceId })),
      defaultServiceId,
      matched: true,
      reason: defaultServiceId
        ? `${rows.length} services in "${categoryName}".`
        : `${rows.length} services in "${categoryName}", but none named "${DEFAULT_FLYER_SERVICE_NAME}" — ` +
          `a flyer saved without a chosen service will have no service on its task.`,
    }
  } catch (err) {
    return unmatched('Could not read the service catalog: ' + (err instanceof Error ? err.message : String(err)))
  }
}

/**
 * Active clients in the offer-flyer department, by name.
 *
 * Membership is `client_service_pricing`, not campaigns or tasks: it is a
 * superset of both, and it is the only one that includes a client who has
 * been set up but has no flyer yet — which is the deadlock this list exists
 * to avoid (with no active campaign there was no client to pick, so the first
 * offer of a cycle could never be saved).
 */
export async function offerFlyerClients(
  admin: SupabaseClient,
  department: FlyerDepartment,
): Promise<{ id: string; name: string }[]> {
  const all = async () => {
    const { data } = await admin
      .from('clients').select('id, name').eq('is_active', true).order('name')
    return ((data as { id: string; name: string | null }[] | null) || [])
      .map(c => ({ id: c.id, name: c.name || 'Unnamed client' }))
  }

  if (!department.matched || !department.serviceIds.length) return all()

  try {
    const { data: priced } = await admin
      .from('client_service_pricing')
      .select('client_id')
      .in('service_id', department.serviceIds)
    const clientIds = [...new Set(
      ((priced as { client_id: string | null }[] | null) || [])
        .map(r => r.client_id)
        .filter((id): id is string => !!id),
    )]
    if (!clientIds.length) return all()

    const { data } = await admin
      .from('clients')
      .select('id, name')
      .eq('is_active', true)
      .in('id', clientIds)
      .order('name')
    const rows = ((data as { id: string; name: string | null }[] | null) || [])
      .map(c => ({ id: c.id, name: c.name || 'Unnamed client' }))
    return rows.length ? rows : all()
  } catch {
    return all()
  }
}

/**
 * The service a flyer save should be filed under.
 *
 * The caller's choice wins, but only when it really is a flyer service — a
 * stale id, or one belonging to another department, falls back to the default
 * rather than filing a supermarket flyer as "Video Editing".
 */
export async function resolveFlyerService(
  admin: SupabaseClient,
  requested: string | null | undefined,
): Promise<{ serviceId: string | null; department: FlyerDepartment; substituted: boolean }> {
  const department = await offerFlyerDepartment(admin)
  const wanted = (requested || '').trim() || null

  if (wanted && department.matched && department.serviceIds.includes(wanted)) {
    return { serviceId: wanted, department, substituted: false }
  }
  if (wanted && !department.matched) {
    // Cannot check membership; trust the caller rather than drop their choice.
    return { serviceId: wanted, department, substituted: false }
  }
  if (department.defaultServiceId) {
    return { serviceId: department.defaultServiceId, department, substituted: !!wanted }
  }

  // No department, or no "Offer Flyer" inside it — the pre-existing
  // workspace-wide lookup, kept so an unconfigured catalog still files a task.
  try {
    const { data: svc } = await admin
      .from('services')
      .select('id')
      .eq('is_active', true)
      .ilike('name', DEFAULT_FLYER_SERVICE_NAME)
      .limit(1)
      .maybeSingle()
    return {
      serviceId: (svc as { id?: string } | null)?.id || null,
      department,
      substituted: !!wanted,
    }
  } catch {
    return { serviceId: null, department, substituted: !!wanted }
  }
}
