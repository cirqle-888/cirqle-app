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

    return NextResponse.json({ ok: true, offers, services }, { headers: CORS_HEADERS })
  } catch (err) {
    // The plugin promises "never crash, always explain" — hold the server to
    // the same bar instead of letting Next return an opaque 500 page.
    const message = err instanceof Error ? err.message : 'Unknown server error'
    return NextResponse.json({ ok: false, error: message }, { status: 500, headers: CORS_HEADERS })
  }
}
