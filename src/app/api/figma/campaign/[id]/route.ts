import { NextRequest, NextResponse } from 'next/server'
import { FIGMA_CORS_HEADERS as CORS_HEADERS, figmaOptions, verifyFigmaAuth } from '../../_lib/auth'
import { OFFER_SHEET_HEADERS, buildOfferSheetRows, figmaLayerName } from '@/lib/offer-sheet'

/**
 * GET /api/figma/campaign/[id] — one campaign, fully hydrated, for the
 * Cirqle Studio Figma plugin's Build Flyer step.
 *
 * Two views of the same data are returned on purpose:
 *
 *  - `products`: rich objects (name, price, mrp, badges, offerType, category,
 *    imageUrl, weight, page, displayOrder) for the plugin's validation panel.
 *  - `bindings`: headers + rows from buildOfferSheetRows — the EXACT contract
 *    the Google Sheet receives today. The plugin fills text layers from this,
 *    so a template that worked with the Sheets plugin fills identically here,
 *    down to the split Price 1/Price 2 and the two date strings.
 *
 * Fields the spec asks for that the schema cannot honestly provide:
 *  - `brand` — exists only on the GLOBAL catalog (product_catalog.brand);
 *    offer_products references the per-client catalog, which has no brand.
 *    Returned as null rather than guessed by name-matching.
 *  - `sku`  — no SKU column exists anywhere; nearest are product_code /
 *    barcode on the global catalog. Returned as null.
 *  Both are documented in the plugin's LIMITATIONS.md instead of being faked.
 *
 * `category` IS real: offer_products.catalog_id → client_product_catalog.category.
 */

export const dynamic = 'force-dynamic'

export const OPTIONS = figmaOptions

/** Mirrors the (unexported) formatDate in google-sheets/sync.ts so the
 *  Offer Date column matches what the Sheet pipeline writes. */
function formatOfferDate(campaign: {
  date_type: string
  offer_date?: string | null
  offer_date_from?: string | null
  offer_date_to?: string | null
}): string {
  if (campaign.date_type === 'single' && campaign.offer_date) {
    return new Date(campaign.offer_date + 'T00:00:00').toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric',
    })
  }
  if (campaign.date_type === 'range') {
    const fmt = (d?: string | null) => d
      ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : ''
    const from = fmt(campaign.offer_date_from)
    const to = fmt(campaign.offer_date_to)
    return [from, to].filter(Boolean).join(' – ')
  }
  return ''
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifyFigmaAuth(req)
    if (!auth.ok) return auth.response
    const admin = auth.admin

    const { id } = await params

    const { data: campaign, error } = await admin
      .from('offer_campaigns')
      .select(`
        id, title, status, date_type, offer_date, offer_date_from, offer_date_to, updated_at,
        client:clients(id, name),
        products:offer_products(
          id, name, weight, price, mrp, offer_type, offer_text, image_url, page, display_order,
          badges:offer_product_badges(custom_label, badge:offer_badges(label)),
          catalog:client_product_catalog(category)
        )
      `)
      .eq('id', id)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500, headers: CORS_HEADERS })
    }
    if (!campaign) {
      return NextResponse.json(
        { ok: false, error: 'Campaign not found. Refresh the offer list — it may have been archived.' },
        { status: 404, headers: CORS_HEADERS },
      )
    }

    // Local row shapes for the untyped admin client — keeps the repo's
    // "no new no-explicit-any" lint rule intact. BadgeRow matches the
    // SheetBadge shape buildOfferSheetRows already accepts.
    type BadgeRef = { label: string | null }
    type BadgeRow = { custom_label: string | null; badge: BadgeRef | BadgeRef[] | null }
    type ProductRow = {
      id: string
      name: string | null
      weight: string | null
      price: number | null
      mrp: number | null
      offer_type: string | null
      offer_text: string | null
      image_url: string | null
      page: number | null
      display_order: number | null
      badges: BadgeRow[] | null
      catalog: { category: string | null } | { category: string | null }[] | null
    }
    type ClientRef = { id: string; name: string | null }

    const client = Array.isArray(campaign.client)
      ? (campaign.client as ClientRef[])[0]
      : (campaign.client as ClientRef | null)
    const rawProducts: ProductRow[] = (campaign.products || []) as ProductRow[]

    const badgeLabels = (p: ProductRow): string[] =>
      (p.badges || [])
        .map((b) => {
          if (b.custom_label) return b.custom_label
          const relation = Array.isArray(b.badge) ? b.badge[0] : b.badge
          return relation?.label || ''
        })
        .filter(Boolean)

    const products = [...rawProducts]
      .sort((a, b) => (a.page || 1) - (b.page || 1) || (a.display_order || 0) - (b.display_order || 0))
      .map((p) => {
        const catalog = Array.isArray(p.catalog) ? p.catalog[0] : p.catalog
        const badges = badgeLabels(p)
        return {
          id: p.id,
          name: p.name || '',
          price: p.price,
          mrp: p.mrp,
          badge: badges[0] || '',
          badges,
          offerType: p.offer_type || 'price',
          offerText: p.offer_text || '',
          category: catalog?.category || null,
          imageUrl: p.image_url || null,
          weight: p.weight || '',
          page: p.page || 1,
          displayOrder: p.display_order || 0,
          // Schema honesty — see the header comment. Do not "fix" these by
          // name-matching against the global catalog from this route.
          brand: null as string | null,
          sku: null as string | null,
        }
      })

    // Lock state, fetched separately + tolerantly: pre-migration schemas
    // simply report "not locked" instead of 500ing the whole load.
    const lockInfo: { lockedAt: string | null; lockedBy: string | null } = { lockedAt: null, lockedBy: null }
    {
      const { data: lockRow } = await admin
        .from('offer_campaigns')
        .select('design_locked_at, design_locked_by')
        .eq('id', id)
        .maybeSingle()
      const lr = lockRow as { design_locked_at?: string | null; design_locked_by?: string | null } | null
      lockInfo.lockedAt = lr?.design_locked_at || null
      lockInfo.lockedBy = lr?.design_locked_by || null
    }

    const offerDate = formatOfferDate(campaign)
    const rows = buildOfferSheetRows({
      clientName: client?.name,
      offerTitle: campaign.title,
      offerDate,
      dates: campaign,
      products: rawProducts,
    })

    return NextResponse.json(
      {
        ok: true,
        campaign: {
          id: campaign.id,
          name: campaign.title || 'Weekly Offer',
          status: campaign.status,
          updatedAt: campaign.updated_at,
          offerDate,
          // Raw date fields so a plugin UPDATE can send back what it loaded
          // instead of collapsing every campaign to today's single date.
          dateType: campaign.date_type || 'single',
          offerDateRaw: campaign.offer_date || null,
          offerDateFrom: campaign.offer_date_from || null,
          offerDateTo: campaign.offer_date_to || null,
          // Design lock state for the "Mark as Designed" control. Fetched
          // tolerantly (below) so a pre-migration schema returns null.
          designLockedAt: lockInfo.lockedAt,
          designLockedBy: lockInfo.lockedBy,
          clientId: client?.id ?? null,
          clientName: client?.name ?? 'Unknown client',
          pageCount: products.length ? Math.max(...products.map(p => p.page)) : 0,
          productCount: products.length,
        },
        products,
        bindings: {
          headers: OFFER_SHEET_HEADERS,
          layers: OFFER_SHEET_HEADERS.map(h => figmaLayerName(h)),
          rows,
        },
      },
      { headers: CORS_HEADERS },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown server error'
    return NextResponse.json({ ok: false, error: message }, { status: 500, headers: CORS_HEADERS })
  }
}
