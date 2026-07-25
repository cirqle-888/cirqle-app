import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

/**
 * GET /api/figma/offers — the Cirqle Studio Figma plugin's offer list.
 *
 * Read-only. Returns every ACTIVE campaign with just enough for the plugin's
 * Client → Offer dropdowns and status line: client id/name, campaign id/name,
 * page count, product count, status, updated_at (updated_at so the plugin can
 * show "changed since you loaded" without downloading the campaign).
 *
 * Auth: `Authorization: Bearer <offer_sheet_secret>` — the workspace secret
 * that already exists in company_settings for the Sheets sync. Reusing it
 * means no new credential to provision or rotate; retiring the Sheet pipeline
 * later doesn't strand this route because the secret belongs to the
 * workspace, not to the Apps Script.
 *
 * CORS: the plugin UI runs in an iframe with a `null` origin, so the wildcard
 * is the only workable value. It is safe here because the bearer token is the
 * actual gate — CORS only decides whether the browser hands the response to
 * the page, and an unauthorized caller gets nothing worth handing over.
 */

export const dynamic = 'force-dynamic'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

export async function GET(req: NextRequest) {
  try {
    const admin = createAdminClient()

    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
    const { data: secretRow } = await admin
      .from('company_settings')
      .select('value')
      .eq('key', 'offer_sheet_secret')
      .maybeSingle()
    const secret = (secretRow?.value || '').trim()

    // Fail closed: an unset secret refuses every request rather than
    // accepting them all (same stance as the shared Apps Script).
    if (!secret || !bearer || bearer !== secret) {
      return NextResponse.json(
        { ok: false, error: 'Unauthorized. Paste the shared secret from Apps → Offer Intake → Shared sync script.' },
        { status: 401, headers: CORS_HEADERS },
      )
    }

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

    return NextResponse.json({ ok: true, offers }, { headers: CORS_HEADERS })
  } catch (err) {
    // The plugin promises "never crash, always explain" — hold the server to
    // the same bar instead of letting Next return an opaque 500 page.
    const message = err instanceof Error ? err.message : 'Unknown server error'
    return NextResponse.json({ ok: false, error: message }, { status: 500, headers: CORS_HEADERS })
  }
}
