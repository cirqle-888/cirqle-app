import { NextRequest, NextResponse } from 'next/server'
import { FIGMA_CORS_HEADERS as CORS_HEADERS, figmaOptions, verifyFigmaAuth } from '../_lib/auth'
import { getMergedClientCatalog, mirrorProductToGlobalCatalog } from '@/lib/offer-catalog'
import { isFeatureEnabled, FEATURE_DISABLED_BODY } from '@/lib/feature-flags'

/**
 * /api/figma/catalog — the Cirqle Studio plugin's window into the product
 * database, so designers can pull past products (with photos) straight into
 * the offer grid and register new ones without leaving Figma.
 *
 *  GET  ?clientId=&q=&limit=  → the same merged picker the client intake
 *       shows (own catalog + region-scoped approved library + image history).
 *  POST {clientId, name, weight?, imageUrl?}
 *       → find-or-create in the global catalog + assign to the client — the
 *       exact mirror path every offer save already runs, so a product created
 *       here is indistinguishable from one that arrived with an offer.
 *
 * Feature-flagged (`feature_figma_catalog` in company_settings) so it can be
 * switched off in production without a deploy. Auth + CORS + version gate:
 * ../_lib/auth.ts.
 */

export const dynamic = 'force-dynamic'

export const OPTIONS = figmaOptions

const MAX_LIMIT = 100

export async function GET(req: NextRequest) {
  try {
    const auth = await verifyFigmaAuth(req)
    if (!auth.ok) return auth.response
    const admin = auth.admin

    if (!(await isFeatureEnabled(admin, 'feature_figma_catalog', true))) {
      return NextResponse.json(FEATURE_DISABLED_BODY, { status: 403, headers: CORS_HEADERS })
    }

    const url = new URL(req.url)
    const clientId = (url.searchParams.get('clientId') || '').trim()
    const q = (url.searchParams.get('q') || '').trim()
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(url.searchParams.get('limit') || '60', 10) || 60))

    if (!clientId) {
      return NextResponse.json(
        { ok: false, error: 'clientId is required.' },
        { status: 400, headers: CORS_HEADERS },
      )
    }

    const { data: client } = await admin
      .from('clients')
      .select('id, region, is_active')
      .eq('id', clientId)
      .maybeSingle()
    const clientRow = client as { id: string; region?: string | null; is_active?: boolean } | null
    if (!clientRow || clientRow.is_active === false) {
      return NextResponse.json(
        { ok: false, error: 'That client no longer exists or is inactive.' },
        { status: 404, headers: CORS_HEADERS },
      )
    }

    const entries = await getMergedClientCatalog(admin, clientRow, q || undefined, limit)
    return NextResponse.json(
      {
        ok: true,
        products: entries.map(e => ({
          id: e.id,
          name: e.name,
          weight: e.weight || null,
          category: e.category || null,
          imageUrl: e.image_url || null,
          images: (e.images || []).map(i => ({ id: i.id, url: i.url, isPrimary: i.is_primary })),
        })),
      },
      { headers: CORS_HEADERS },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown server error'
    return NextResponse.json({ ok: false, error: message }, { status: 500, headers: CORS_HEADERS })
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await verifyFigmaAuth(req)
    if (!auth.ok) return auth.response
    const admin = auth.admin

    if (!(await isFeatureEnabled(admin, 'feature_figma_catalog', true))) {
      return NextResponse.json(FEATURE_DISABLED_BODY, { status: 403, headers: CORS_HEADERS })
    }

    const body = (await req.json().catch(() => null)) as {
      clientId?: string
      name?: string
      weight?: string | null
      imageUrl?: string | null
    } | null
    const clientId = (body?.clientId || '').trim()
    const name = (body?.name || '').trim()
    if (!clientId || !name) {
      return NextResponse.json(
        { ok: false, error: 'clientId and name are required.' },
        { status: 400, headers: CORS_HEADERS },
      )
    }

    const { data: client } = await admin
      .from('clients')
      .select('id, is_active')
      .eq('id', clientId)
      .maybeSingle()
    if (!client || (client as { is_active?: boolean }).is_active === false) {
      return NextResponse.json(
        { ok: false, error: 'That client no longer exists or is inactive.' },
        { status: 404, headers: CORS_HEADERS },
      )
    }

    // Same path as every offer save — new names land as review_status
    // 'pending' for staff to curate; the client/designer can use them
    // immediately.
    await mirrorProductToGlobalCatalog(
      admin,
      clientId,
      name,
      (body?.weight || '').trim() || null,
      (body?.imageUrl || '').trim() || null,
    )

    return NextResponse.json(
      { ok: true, message: `${name} saved to the product database.` },
      { headers: CORS_HEADERS },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown server error'
    return NextResponse.json({ ok: false, error: message }, { status: 500, headers: CORS_HEADERS })
  }
}
