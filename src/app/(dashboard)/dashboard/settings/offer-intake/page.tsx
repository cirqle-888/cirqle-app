import { createAdminClient } from '@/lib/supabase/admin'
import { enforceAuth } from '@/lib/auth/enforce'
import { headers } from 'next/headers'
import OfferIntakeSettingsClient from './offer-intake-settings-client'

export const dynamic = 'force-dynamic'

export default async function OfferIntakeSettingsPage() {
  await enforceAuth()
  const admin = createAdminClient()

  const { data: clients } = await admin
    .from('clients')
    .select('id, name, code, is_active, offer_intake_token, offer_sheet_webhook_url')
    .eq('is_active', true)
    .order('name')

  // Derive app URL for generating intake links
  const headersList = await headers()
  const host = headersList.get('host') || 'localhost:3000'
  const proto = host.includes('localhost') ? 'http' : 'https'
  const appUrl = `${proto}://${host}`

  return (
    <OfferIntakeSettingsClient
      clients={clients || []}
      appUrl={appUrl}
    />
  )
}
