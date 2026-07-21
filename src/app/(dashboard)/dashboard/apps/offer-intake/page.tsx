import { createAdminClient } from '@/lib/supabase/admin'
import { selectWithOptionalColumns } from '@/lib/offer-columns'
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

  const [clientsRaw, kindsByClient, { data: settingsRows }] = await Promise.all([
    selectWithOptionalColumns<any[]>(
      'id, name, code, is_active, offer_intake_token, offer_sheet_webhook_url, offer_sheet_url, has_offer_flyer_service',
      ['offer_flow_mode', 'offer_master_sheet_url', 'integrations'],
      cols => admin.from('clients').select(cols).eq('is_active', true).order('name'),
    ),
    getIntakeKindsByClient(),
    admin
      .from('company_settings')
      .select('key, value')
      .in('key', ['offer_sheet_webhook_url', 'offer_sheet_secret']),
  ])

  // Categories, keyed by client. Wrapped so the page still renders if the
  // migration has not been applied yet — every client then looks single-list,
  // which is exactly the pre-categories behaviour.
  let groupsByClient: Record<string, any[]> = {}
  try {
    const { data: groupRows } = await admin
      .from('client_offer_groups')
      .select('id, client_id, name, slug, sheet_url, sheet_tab_name, master_tab_name, apps_script_url, integrations, display_order, is_active, last_pulled_at')
      .is('parent_id', null)
      .eq('is_active', true)
      .order('display_order')
    for (const row of groupRows || []) {
      ;(groupsByClient[row.client_id] ||= []).push(row)
    }
  } catch {
    groupsByClient = {}
  }

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
      groupsByClient={groupsByClient}
    />
  )
}
