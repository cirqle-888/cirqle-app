import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import {
  SHOP_KEY, cleanBanner, cleanProduct, cleanSettings, todayInIndia,
  type ShopBanner, type ShopProduct,
} from '@/lib/shop/catalogue'
import ShopClient from './shop-client'

export const dynamic = 'force-dynamic'

/**
 * Shop — what the Memoura website sells and announces: gifts (on/off, add,
 * edit), the top banner, print prices, delivery charges and highlight cards.
 *
 * The website reads the same three tables through /api/shop/memoura, so a
 * change saved here shows on the site within about a minute. The tables are
 * server-only; this page reads with the service role behind orders.view.
 */
export default async function ShopPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  if (!me || !(isAdmin || hasPermission(me, PERMS.ORDERS_VIEW))) redirect('/dashboard')
  const canManage = isAdmin || hasPermission(me, PERMS.ORDERS_MANAGE)

  const admin = createAdminClient()
  const [products, banners, settings] = await Promise.all([
    admin.from('shop_products').select('*').is('deleted_at', null).order('sort', { ascending: true }),
    admin.from('shop_banners').select('*').is('deleted_at', null).order('sort', { ascending: true }),
    admin.from('shop_settings').select('value').eq('shop', SHOP_KEY).maybeSingle(),
  ])

  // Probed, not assumed: safe to deploy before 20261123090000_shop_catalogue runs.
  const notSetUp = !!(products.error || banners.error || settings.error)
  const productList: ShopProduct[] = ((products.data ?? []) as Record<string, unknown>[]).map(cleanProduct)
  const bannerList: ShopBanner[] = ((banners.data ?? []) as Record<string, unknown>[]).map(cleanBanner)

  return (
    <ShopClient
      products={productList}
      banners={bannerList}
      settings={cleanSettings(settings.data?.value)}
      canManage={canManage}
      notSetUp={notSetUp}
      today={todayInIndia()}
    />
  )
}
