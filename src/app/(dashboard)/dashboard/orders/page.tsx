import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadBrands } from '@/lib/brands/load'
import { resolveBrandLens } from '@/lib/brands/lens'
import { cleanExtras, cleanItems, type ShopOrder } from '@/lib/orders/orders'
import OrdersClient from './orders-client'

export const dynamic = 'force-dynamic'

/**
 * Orders — retail orders for Cirqle's own product brands (Memoura).
 *
 * Buyers are members of the public, not clients, and their name, phone and
 * address are personal data: `shop_orders` is server-only (RLS, no browser
 * grants), so this page reads with the service role behind orders.view and
 * hands plain props to the client. All writes are in actions.ts.
 */
export default async function OrdersPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canView = isAdmin || hasPermission(me, PERMS.ORDERS_VIEW)
  if (!me || !canView) redirect('/dashboard')
  const canManage = isAdmin || hasPermission(me, PERMS.ORDERS_MANAGE)

  const admin = createAdminClient()
  const [brands, lens] = await Promise.all([
    loadBrands(admin).catch(() => []),
    resolveBrandLens(admin).catch(() => null),
  ])
  // The brand this screen sells for: the one being looked at, else Memoura.
  const shopBrand = lens?.brand ?? brands.find(b => b.slug === 'memoura') ?? null

  let query = admin
    .from('shop_orders')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(500)
  if (lens) query = query.eq('brand_id', lens.brand.id)
  const { data, error } = await query

  // Probed, not assumed: safe to deploy before 20261122180000_shop_orders runs.
  const notSetUp = !!error
  const orders: ShopOrder[] = ((data ?? []) as Record<string, unknown>[]).map(r => ({
    ...(r as unknown as ShopOrder),
    items: cleanItems(r.items),
    extras: cleanExtras(r.extras),
    items_total: Number(r.items_total) || 0,
    extras_total: Number(r.extras_total) || 0,
    delivery_charge: Number(r.delivery_charge) || 0,
    total: Number(r.total) || 0,
    amount_paid: Number(r.amount_paid) || 0,
  }))

  return (
    <OrdersClient
      orders={orders}
      canManage={canManage}
      notSetUp={notSetUp}
      brand={shopBrand ? { id: shopBrand.id, name: shopBrand.name } : null}
    />
  )
}
