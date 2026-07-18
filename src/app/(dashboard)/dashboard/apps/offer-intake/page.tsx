import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCurrentEmployeeId } from '@/lib/auth/enforce'
import { getIntakeKindsByClient } from '@/lib/services/intake-server'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import OfferIntakeSettingsClient from './offer-intake-settings-client'

export const dynamic = 'force-dynamic'

export default async function OfferIntakeSettingsPage() {
  const employeeId = await resolveCurrentEmployeeId()
  if (!employeeId) redirect('/login')

  const admin = createAdminClient()

  const [{ data: clientsRaw }, kindsByClient, { data: settingsRows }] = await Promise.all([
    admin
      .from('clients')
      .select('id, name, code, is_active, offer_intake_token, offer_sheet_webhook_url, offer_sheet_url, has_offer_flyer_service')
      .eq('is_active', true)
      .order('name'),
    getIntakeKindsByClient(),
    admin
      .from('company_settings')
      .select('key, value')
      .in('key', ['offer_sheet_webhook_url', 'offer_sheet_secret']),
  ])

  const settingsMap = Object.fromEntries((settingsRows || []).map(r => [r.key, r.value]))
  const globalConfig = {
    webhookUrl: (settingsMap['offer_sheet_webhook_url'] || '').trim(),
    secret: (settingsMap['offer_sheet_secret'] || '').trim(),
    configured: !!(settingsMap['offer_sheet_webhook_url'] || '').trim(),
  }

  // Capability is SERVICE-DRIVEN: a client has the offer service when any of
  // their assigned services has intake_kind = 'offer_intake'. The legacy
  // has_offer_flyer_service column is kept only as a manual override.
  const clients = (clientsRaw || [])
    .map(c => ({
      ...c,
      has_offer_flyer_service:
        (kindsByClient.get(c.id)?.includes('offer_intake') ?? false) || !!c.has_offer_flyer_service,
    }))
    .filter(c => c.has_offer_flyer_service)

  // Derive app URL for generating intake links
  const headersList = await headers()
  const host = headersList.get('host') || 'localhost:3000'
  const proto = host.includes('localhost') ? 'http' : 'https'
  const appUrl = `${proto}://${host}`

  return (
    <OfferIntakeSettingsClient
      clients={clients || []}
      appUrl={appUrl}
      globalConfig={globalConfig}
    />
  )
}
