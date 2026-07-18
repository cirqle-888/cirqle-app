import { redirect } from 'next/navigation'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import PricingMatrixClient from './pricing-matrix-client'

export const dynamic = 'force-dynamic'

/**
 * Pricing Matrix — standalone full-canvas module, extracted out of Settings
 * so the grid gets the full page width instead of Settings' fixed-rail layout.
 * Gated by `settings.access`, matching the `upsertMatrixCell` server action.
 */
export default async function PricingMatrixPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true
  const canEdit = isAdmin || hasPermission(me, PERMS.SETTINGS_ACCESS)
  if (me && !canEdit) redirect('/dashboard')

  const supabase = createAdminClient()

  const [clientsRes, servicesRes] = await Promise.all([
    fetchAll(supabase.from('clients')
      .select('id, name, code, is_active, default_currency, pricing_pending, service_pricings:client_service_pricing(*)')
      .order('name')),
    fetchAll(supabase.from('services')
      .select('id, name, is_active, pricing_type, default_price, pricing_pending')
      .order('name')),
  ])

  return (
    <PricingMatrixClient
      clients={(clientsRes.data || []) as any[]}
      services={(servicesRes.data || []) as any[]}
    />
  )
}
