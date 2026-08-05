import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import NewCampaignForm from './new-campaign-form'

export const dynamic = 'force-dynamic'

export default async function NewCampaignPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canCreate = isAdmin || hasPermission(me, PERMS.ADVERTISING_CREATE)
  if (me && !canCreate) redirect('/dashboard/advertising')

  // Agency rates are confidential (advertising.view_financials, migration 027)
  // — a creator without it still creates campaigns, just without seeing the
  // per-service / per-client charge amounts. Stripped server-side.
  const viewFinancials = isAdmin
    || hasPermission(me, PERMS.ADVERTISING_VIEW_FINANCIALS)
    || hasPermission(me, PERMS.ADVERTISING_MANAGE_BUDGET)

  const admin = createAdminClient()
  const [clientsRes, servicesRes, pricingRes] = await Promise.all([
    admin.from('clients').select('id, name, code').order('name'),
    admin.from('services').select('id, name, pricing_type, default_price').eq('is_active', true).order('display_order').order('name'),
    // Per-client rate overrides (e.g. a custom % for a given client).
    viewFinancials
      ? admin.from('client_service_pricing').select('client_id, service_id, price').not('price', 'is', null)
      : Promise.resolve({ data: [] as { client_id: string; service_id: string; price: number }[] }),
  ])

  return (
    <NewCampaignForm
      clients={clientsRes.data || []}
      services={viewFinancials
        ? (servicesRes.data || [])
        : (servicesRes.data || []).map(s => ({ ...s, default_price: null }))}
      servicePricing={pricingRes.data || []}
    />
  )
}
