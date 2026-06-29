import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import NewCampaignForm from './new-campaign-form'

export const dynamic = 'force-dynamic'

export default async function NewCampaignPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true
  const canCreate = isAdmin || hasPermission(me, PERMS.ADVERTISING_CREATE)
  if (me && !canCreate) redirect('/dashboard/advertising')

  const admin = createAdminClient()
  const [clientsRes, servicesRes, pricingRes] = await Promise.all([
    admin.from('clients').select('id, name, code').order('name'),
    admin.from('services').select('id, name, pricing_type, default_price').eq('is_active', true).order('display_order').order('name'),
    // Per-client rate overrides (e.g. a custom % for a given client).
    admin.from('client_service_pricing').select('client_id, service_id, price').not('price', 'is', null),
  ])

  return (
    <NewCampaignForm
      clients={clientsRes.data || []}
      services={servicesRes.data || []}
      servicePricing={pricingRes.data || []}
    />
  )
}
