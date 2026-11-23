import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { SHOP_KEY, cleanBanner, cleanProduct, cleanSettings, publicCatalogue, todayInIndia } from '@/lib/shop/catalogue'

export const dynamic = 'force-dynamic'

/**
 * The Memoura website's price list, as JSON.
 *
 * Deliberately public and read-only: the website is a static page in the
 * buyer's browser and cannot hold a session. It sends out exactly what the
 * site already prints on screen (gifts that are switched on, banners, print
 * sizes, delivery charges) and nothing else: no orders, no buyers, no gift
 * that is switched off, no internal ids. See publicCatalogue().
 *
 * Any origin may read it (the site runs on its own domain and on localhost
 * while it is being worked on). Cached for a minute at the edge so a busy
 * shop page costs the database one read a minute, not one per visitor.
 *
 * If the tables are missing or the database is down this answers 503 and the
 * website keeps showing its built-in copy.
 */
const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300',
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: HEADERS })
}

export async function GET() {
  try {
    const admin = createAdminClient()
    const [products, banners, settings] = await Promise.all([
      admin.from('shop_products').select('slug, name, meta, price, pieces, badge, description, needs, who, occ, ready, image_url, active, sort').is('deleted_at', null),
      admin.from('shop_banners').select('title, body, starts_on, ends_on, free_extra, free_with, active, sort').is('deleted_at', null),
      admin.from('shop_settings').select('value').eq('shop', SHOP_KEY).maybeSingle(),
    ])
    if (products.error || banners.error || settings.error) throw new Error('unavailable')
    const body = publicCatalogue(
      ((products.data ?? []) as Record<string, unknown>[]).map(cleanProduct),
      ((banners.data ?? []) as Record<string, unknown>[]).map(cleanBanner),
      cleanSettings(settings.data?.value),
      todayInIndia(),
    )
    return NextResponse.json(body, { headers: HEADERS })
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers: { ...HEADERS, 'Cache-Control': 'no-store' } })
  }
}
