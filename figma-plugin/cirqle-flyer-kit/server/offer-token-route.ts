/**
 * GET /api/figma/offers/[token] — one campaign as sheet-shaped rows, for the
 * Figma plugin to build cards from.
 *
 * Returns { headers, rows } produced by the SAME buildOfferSheetRows helper
 * the Google Sheet sync uses, so a flyer built from this endpoint is
 * byte-for-byte identical to one built from the Sheet. That parity is the
 * whole point: the plugin is a faster transport for the same contract, not a
 * second source of truth.
 *
 * ⚠ Before deploying, mirror the exact buildOfferSheetRows(...) invocation
 * from src/lib/google-sheets/sync.ts — argument shapes may have drifted since
 * this file was written.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildOfferSheetRows, OFFER_SHEET_HEADERS } from '@/lib/offer-sheet'

export const dynamic = 'force-dynamic'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const supabase = await createClient()

  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
  const { data: secretRow } = await supabase
    .from('company_settings')
    .select('value')
    .eq('key', 'offer_sheet_secret')
    .maybeSingle()
  if (!bearer || !secretRow?.value || secretRow.value !== bearer) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: CORS })
  }

  const { token } = await params

  const { data: campaign, error } = await supabase
    .from('offer_campaigns')
    .select(`
      id, title, date_type, offer_date, offer_date_from, offer_date_to, updated_at,
      clients(name),
      offer_products(
        id, name, weight, image_url, offer_type, price, mrp, offer_text, page, display_order,
        offer_product_badges(custom_label, display_order, offer_badges(label))
      )
    `)
    .eq('offer_token', token)
    .eq('status', 'active')
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: CORS })
  if (!campaign) return NextResponse.json({ error: 'No active campaign for this token' }, { status: 404, headers: CORS })

  const clientName = Array.isArray(campaign.clients)
    ? campaign.clients[0]?.name
    : (campaign.clients as { name?: string } | null)?.name

  const products = (campaign.offer_products ?? [])
    .sort((a, b) => (a.page - b.page) || (a.display_order - b.display_order))
    .map((p) => ({
      name: p.name,
      weight: p.weight,
      image_url: p.image_url,
      offer_type: p.offer_type,
      price: p.price,
      mrp: p.mrp,
      offer_text: p.offer_text,
      page: p.page,
      display_order: p.display_order,
      badges: (p.offer_product_badges ?? [])
        .sort((a, b) => a.display_order - b.display_order)
        .map((pb) => pb.custom_label
          || (Array.isArray(pb.offer_badges) ? pb.offer_badges[0]?.label : (pb.offer_badges as { label?: string } | null)?.label)
          || '')
        .filter(Boolean),
    }))

  // ⚠ Mirror the invocation in src/lib/google-sheets/sync.ts here.
  const rows = buildOfferSheetRows({
    products,
    clientName: clientName ?? '',
    campaign: {
      title: campaign.title,
      date_type: campaign.date_type,
      offer_date: campaign.offer_date,
      offer_date_from: campaign.offer_date_from,
      offer_date_to: campaign.offer_date_to,
    },
  } as Parameters<typeof buildOfferSheetRows>[0])

  return NextResponse.json(
    {
      headers: OFFER_SHEET_HEADERS,
      rows,
      client: clientName,
      title: campaign.title,
      updatedAt: campaign.updated_at,
    },
    { headers: CORS }
  )
}
