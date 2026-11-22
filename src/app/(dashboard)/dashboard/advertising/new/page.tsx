import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadPageOptions } from '@/lib/advertising/campaign-page'
import { loadBrands } from '@/lib/brands/load'
import NewCampaignForm from './new-campaign-form'

export const dynamic = 'force-dynamic'

export default async function NewCampaignPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canCreate = isAdmin || hasPermission(me, PERMS.ADVERTISING_CREATE)
  if (me && !canCreate) redirect('/dashboard/advertising')

  // Agency rate cards are billing data (advertising.view_billing, migration
  // 027) — a creator without it still creates campaigns, just without seeing
  // the per-service / per-client charge amounts. Stripped server-side.
  const viewBilling = isAdmin
    || hasPermission(me, PERMS.ADVERTISING_VIEW_BILLING)
    || hasPermission(me, PERMS.ADVERTISING_MANAGE_BUDGET)

  const admin = createAdminClient()
  const [clientsRes, servicesRes, pricingRes, pages, brands] = await Promise.all([
    admin.from('clients').select('id, name, code').order('name'),
    admin.from('services').select('id, name, pricing_type, default_price').eq('is_active', true).order('display_order').order('name'),
    // Per-client rate overrides (e.g. a custom % for a given client).
    viewBilling
      ? admin.from('client_service_pricing').select('client_id, service_id, price').not('price', 'is', null)
      : Promise.resolve({ data: [] as { client_id: string; service_id: string; price: number }[] }),
    // Pages a campaign can advertise (Cirqle's own for company campaigns).
    loadPageOptions(admin),
    loadBrands(admin, { activeOnly: true }),
  ])

  // ?client= preselects the client (the Marketing Hub's "New campaign").
  const sp = await searchParams
  const wanted = typeof sp.client === 'string' ? sp.client : undefined
  const initialClientId = wanted && (clientsRes.data || []).some(c => c.id === wanted) ? wanted : undefined
  // ?brand= preselects one of Cirqle's brands (a brand page's "Campaign").
  const wantedBrand = typeof sp.brand === 'string' ? sp.brand : undefined
  const initialBrandId = wantedBrand && brands.some(b => b.id === wantedBrand) ? wantedBrand : undefined

  return (
    <NewCampaignForm
      initialClientId={initialClientId}
      clients={clientsRes.data || []}
      services={viewBilling
        ? (servicesRes.data || [])
        : (servicesRes.data || []).map(s => ({ ...s, default_price: null }))}
      servicePricing={pricingRes.data || []}
      pages={pages}
      brands={brands.map(b => ({ id: b.id, name: b.name, isDefault: b.is_default }))}
      initialBrandId={initialClientId ? undefined : initialBrandId}
    />
  )
}
