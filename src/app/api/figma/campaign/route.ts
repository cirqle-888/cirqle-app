import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { saveCampaign, type ProductInput } from '@/app/intake/offer/[token]/actions'

/**
 * POST /api/figma/campaign — save an offer parsed in the Cirqle Studio plugin
 * back into Cirqle, BEFORE any cards are built in Figma.
 *
 * Why save-then-build rather than build-from-paste:
 * a list that only ever existed inside a Figma file has no change log, no
 * catalog mirroring, no price history, and is invisible to the rest of the
 * team. Cirqle stays the single source of truth; Figma stays the design
 * surface. The plugin builds from what was saved, so the flyer can always be
 * traced back to a campaign.
 *
 * This route deliberately delegates the whole write to the EXISTING
 * `saveCampaign` server action rather than reimplementing it. That one call
 * carries: product upsert, badge join rows, per-field change logs, client and
 * global catalog mirroring, one-active-campaign-per-client enforcement, and
 * the Google Sheet sync trigger — all behaviour the Offer Intake form already
 * relies on. Duplicating any of it here would create a second, divergent
 * write path.
 *
 * Auth: workspace `offer_sheet_secret` (same as the other figma routes).
 * The client is addressed by `clientId`; its intake token is resolved
 * server-side and never travels to the plugin.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

interface IncomingProduct {
  name?: string
  price?: number | null
  mrp?: number | null
  weight?: string | null
  badge?: string | null
  offerType?: string | null
  page?: number | null
}

interface IncomingBody {
  clientId?: string
  title?: string
  dateType?: 'single' | 'range'
  offerDate?: string
  offerDateFrom?: string
  offerDateTo?: string
  campaignId?: string
  products?: IncomingProduct[]
}

const MAX_PRODUCTS = 300

export async function POST(req: NextRequest) {
  try {
    const admin = createAdminClient()

    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
    const { data: secretRow } = await admin
      .from('company_settings')
      .select('value')
      .eq('key', 'offer_sheet_secret')
      .maybeSingle()
    const secret = (secretRow?.value || '').trim()
    if (!secret || !bearer || bearer !== secret) {
      return NextResponse.json(
        { ok: false, error: 'Unauthorized. Paste the shared secret from Apps → Offer Intake → Shared sync script.' },
        { status: 401, headers: CORS_HEADERS },
      )
    }

    const body = (await req.json().catch(() => null)) as IncomingBody | null
    const clientId = (body?.clientId || '').trim()
    const products = body?.products || []

    if (!clientId) {
      return NextResponse.json(
        { ok: false, error: 'No client selected. Pick a client in the plugin before saving.' },
        { status: 400, headers: CORS_HEADERS },
      )
    }
    if (!products.length) {
      return NextResponse.json(
        { ok: false, error: 'No products to save — parse a list first.' },
        { status: 400, headers: CORS_HEADERS },
      )
    }
    if (products.length > MAX_PRODUCTS) {
      return NextResponse.json(
        { ok: false, error: `${products.length} products exceeds the ${MAX_PRODUCTS} limit for one campaign.` },
        { status: 413, headers: CORS_HEADERS },
      )
    }

    // saveCampaign is addressed by the client's intake token (it is the shared
    // entry point for the public form and the staff editor alike). Resolve it
    // from the id the plugin already holds; the token itself stays server-side.
    const { data: client, error: clientError } = await admin
      .from('clients')
      .select('id, name, offer_intake_token, is_active')
      .eq('id', clientId)
      .maybeSingle()

    if (clientError) {
      return NextResponse.json({ ok: false, error: clientError.message }, { status: 500, headers: CORS_HEADERS })
    }
    if (!client || client.is_active === false) {
      return NextResponse.json(
        { ok: false, error: 'That client no longer exists or is inactive. Press Refresh in the plugin.' },
        { status: 404, headers: CORS_HEADERS },
      )
    }
    if (!client.offer_intake_token) {
      return NextResponse.json(
        {
          ok: false,
          error: `${client.name} has no Offer Intake link yet. Open Apps → Offer Intake in Cirqle and create one for this client, then try again.`,
        },
        { status: 409, headers: CORS_HEADERS },
      )
    }

    const isOfferType = (v: unknown): v is ProductInput['offer_type'] =>
      v === 'price' || v === 'percent' || v === 'bogo' || v === 'other'

    const productInputs: ProductInput[] = products.map((p, index) => {
      const badge = (p.badge || '').trim()
      const offerType = isOfferType(p.offerType) ? p.offerType : 'price'
      return {
        name: (p.name || '').trim() || `Product ${index + 1}`,
        weight: (p.weight || '').trim() || undefined,
        offer_type: offerType,
        price: typeof p.price === 'number' ? p.price : null,
        mrp: typeof p.mrp === 'number' ? p.mrp : null,
        // Free-text badge: the plugin sends a label, not an id, because the
        // client's message says "B1G1", not a badge uuid. saveCampaign accepts
        // custom_label for exactly this case.
        badges: badge ? [{ custom_label: badge, color: 'amber' }] : [],
        page: typeof p.page === 'number' && p.page > 0 ? p.page : 1,
        display_order: index,
      }
    })

    const today = new Date().toISOString().slice(0, 10)
    const dateType = body?.dateType === 'range' ? 'range' : 'single'

    const result = await saveCampaign(
      client.offer_intake_token,
      {
        title: body?.title?.trim() || undefined,
        date_type: dateType,
        offer_date: dateType === 'single' ? (body?.offerDate || today) : undefined,
        offer_date_from: dateType === 'range' ? (body?.offerDateFrom || today) : undefined,
        offer_date_to: dateType === 'range' ? (body?.offerDateTo || today) : undefined,
        client_note: 'Created from Cirqle Studio (Figma).',
        products: productInputs,
      },
      body?.campaignId,
    )

    if (!result.ok || !result.data) {
      return NextResponse.json(
        { ok: false, error: result.error || 'Could not save the offer.' },
        { status: 500, headers: CORS_HEADERS },
      )
    }

    return NextResponse.json(
      {
        ok: true,
        campaignId: result.data.campaignId,
        productCount: productInputs.length,
        clientName: client.name,
        // saveCampaign fires the Google Sheet sync in the background, so a
        // client still on the sheet pipeline stays in step automatically.
        message: `Saved ${productInputs.length} products to ${client.name} in Cirqle.`,
      },
      { headers: CORS_HEADERS },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown server error'
    return NextResponse.json({ ok: false, error: message }, { status: 500, headers: CORS_HEADERS })
  }
}
