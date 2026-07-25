/**
 * GET /api/figma/offers — active offer campaigns, for the Figma plugin's
 * client dropdown and watch mode.
 *
 * Auth: `Authorization: Bearer <offer_sheet_secret>` — the same shared secret
 * company_settings already holds for the Google Sheets sync, so no new
 * credential exists because of this route. Read-only by design.
 *
 * ⚠ Verify the Supabase import matches the one used in
 * src/app/intake/offer/[token]/actions.ts before deploying.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// The plugin iframe has a `null` origin, so only a wildcard works. The bearer
// token is the actual gate; CORS just lets the browser hand over the response.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

async function isAuthorized(req: Request, supabase: Awaited<ReturnType<typeof createClient>>) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return false
  const { data } = await supabase
    .from('company_settings')
    .select('value')
    .eq('key', 'offer_sheet_secret')
    .maybeSingle()
  return !!data?.value && data.value === token
}

export async function GET(req: Request) {
  const supabase = await createClient()

  if (!(await isAuthorized(req, supabase))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: CORS })
  }

  const { data, error } = await supabase
    .from('offer_campaigns')
    .select('offer_token, title, updated_at, offer_date, clients(name), offer_products(count)')
    .eq('status', 'active')
    .order('updated_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: CORS })
  }

  const campaigns = (data ?? []).map((c) => ({
    token: c.offer_token,
    // clients(...) comes back as an object for a to-one relation, but typing
    // varies by supabase-js version; handle both shapes.
    client: Array.isArray(c.clients) ? c.clients[0]?.name : (c.clients as { name?: string } | null)?.name,
    title: c.title,
    updatedAt: c.updated_at,
    offerDate: c.offer_date,
    products: Array.isArray(c.offer_products) ? c.offer_products[0]?.count ?? 0 : 0,
  }))

  return NextResponse.json({ campaigns }, { headers: CORS })
}
