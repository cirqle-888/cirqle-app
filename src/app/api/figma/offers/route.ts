import { NextRequest, NextResponse } from 'next/server'
import { FIGMA_CORS_HEADERS as CORS_HEADERS, figmaOptions, verifyFigmaAuth } from '../_lib/auth'

/**
 * GET /api/figma/offers — the Cirqle Studio Figma plugin's offer list.
 *
 * Read-only. Returns every ACTIVE campaign with just enough for the plugin's
 * Client → Offer dropdowns and status line: client id/name, campaign id/name,
 * page count, product count, status, updated_at (updated_at so the plugin can
 * show "changed since you loaded" without downloading the campaign).
 *
 * Auth + CORS + plugin-version gate: see ../_lib/auth.ts (shared by every
 * figma route).
 */

export const dynamic = 'force-dynamic'

export const OPTIONS = figmaOptions

export async function GET(req: NextRequest) {
  try {
    const auth = await verifyFigmaAuth(req)
    if (!auth.ok) return auth.response
    const admin = auth.admin

    const { data: campaigns, error } = await admin
      .from('offer_campaigns')
      .select(`
        id, title, status, updated_at, offer_date, offer_date_from, offer_date_to, date_type,
        client:clients(id, name),
        products:offer_products(page)
      `)
      .eq('status', 'active')
      .order('updated_at', { ascending: false })

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500, headers: CORS_HEADERS })
    }

    // Local row shapes for the untyped admin client — keeps the repo's
    // "no new no-explicit-any" lint rule intact.
    type ClientRef = { id: string; name: string | null }
    type CampaignRow = {
      id: string
      title: string | null
      status: string
      updated_at: string
      client: ClientRef | ClientRef[] | null
      products: { page: number | null }[] | null
    }

    const offers = ((campaigns || []) as CampaignRow[]).map((c) => {
      const client = Array.isArray(c.client) ? c.client[0] : c.client
      const pages: number[] = (c.products || []).map((p) => p.page || 1)
      return {
        clientId: client?.id ?? null,
        clientName: client?.name ?? 'Unknown client',
        campaignId: c.id,
        campaignName: c.title || 'Weekly Offer',
        pageCount: pages.length ? Math.max(...pages) : 0,
        productCount: pages.length,
        status: c.status,
        updatedAt: c.updated_at,
      }
    })

    // The service list rides along with the offers so the plugin can let the
    // designer say which service this flyer is ("Offer Flyer", "Offer Flyer
    // Updating", "A3 Offer Flyer"…) on the task it creates. Sent with the
    // offers rather than from a route of its own: the plugin already calls
    // this on every connect, and the list is small and rarely changes.
    const { data: serviceRows } = await admin
      .from('services')
      .select('id, name')
      .eq('is_active', true)
      .order('display_order')
      .order('name')
    const services = ((serviceRows as { id: string; name: string | null }[] | null) || [])
      .map(s => ({ id: s.id, name: s.name || '' }))

    // The client list rides along too — and it is deliberately NOT derived
    // from the campaigns above. The plugin used to build its Client dropdown
    // out of the active offers, which deadlocked the very flow the plugin
    // exists to replace: with no active campaign there was no client to pick,
    // so the first offer of a cycle could never be saved from Figma ("pick a
    // client at the top" — pointing at an empty, disabled dropdown). Photo
    // upload and catalog search are gated on the same clientId, so they went
    // with it. Same rationale as `services` for sending it here.
    //
    // Narrowed to the OFFER FLYERS department. This plugin only ever makes
    // offer flyers, so a dropdown of every client in the workspace is a list
    // of mostly wrong answers — and picking one is how a flyer ends up filed
    // against a branding-only client.
    //
    // "Department" is the service CATEGORY (the org has no separate department
    // dimension; category is the proxy the rest of the app uses). Membership is
    // client_service_pricing, not campaigns or tasks: it is a superset of both,
    // and it is the only one that includes a client who has been set up but has
    // no flyer yet — which is exactly the deadlock described above.
    const clients = await offerFlyerClients(admin)

    return NextResponse.json({ ok: true, offers, services, clients }, { headers: CORS_HEADERS })
  } catch (err) {
    // The plugin promises "never crash, always explain" — hold the server to
    // the same bar instead of letting Next return an opaque 500 page.
    const message = err instanceof Error ? err.message : 'Unknown server error'
    return NextResponse.json({ ok: false, error: message }, { status: 500, headers: CORS_HEADERS })
  }
}

/** The service category that defines the offer-flyer department. */
const OFFER_FLYER_CATEGORY = 'Offer Flyers'

/** The service-role client verifyFigmaAuth hands back on success. */
type Admin = Extract<Awaited<ReturnType<typeof verifyFigmaAuth>>, { ok: true }>['admin']

/**
 * Active clients in the offer-flyer department, by name.
 *
 * FAILS OPEN, deliberately. If the category is renamed, emptied, or the lookup
 * errors, this returns every active client rather than an empty dropdown. A
 * slightly-too-long list is a papercut; an empty one means nobody can save a
 * flyer from Figma at all, and the cause (a renamed category) would look
 * nothing like the symptom.
 */
async function offerFlyerClients(
  admin: Admin,
): Promise<{ id: string; name: string }[]> {
  const all = async () => {
    const { data } = await admin
      .from('clients').select('id, name').eq('is_active', true).order('name')
    return ((data as { id: string; name: string | null }[] | null) || [])
      .map((c) => ({ id: c.id, name: c.name || 'Unnamed client' }))
  }

  try {
    const { data: cats } = await admin
      .from('service_categories').select('id').eq('name', OFFER_FLYER_CATEGORY)
    const categoryIds = ((cats as { id: string }[] | null) || []).map((c) => c.id)
    if (!categoryIds.length) return all()

    const { data: svc } = await admin
      .from('services').select('id').in('category_id', categoryIds)
    const serviceIds = ((svc as { id: string }[] | null) || []).map((s) => s.id)
    if (!serviceIds.length) return all()

    const { data: priced } = await admin
      .from('client_service_pricing').select('client_id').in('service_id', serviceIds)
    const clientIds = [...new Set(
      ((priced as { client_id: string | null }[] | null) || [])
        .map((r) => r.client_id).filter((id): id is string => !!id),
    )]
    if (!clientIds.length) return all()

    // Still filtered to active, and still ordered by name — the plugin's
    // dropdown ordering is unchanged, only its length.
    const { data } = await admin
      .from('clients').select('id, name').eq('is_active', true).in('id', clientIds).order('name')
    const rows = ((data as { id: string; name: string | null }[] | null) || [])
      .map((c) => ({ id: c.id, name: c.name || 'Unnamed client' }))
    return rows.length ? rows : all()
  } catch {
    return all()
  }
}
