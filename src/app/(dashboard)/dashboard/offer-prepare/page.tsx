import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { getIntakeKindsByClient } from '@/lib/services/intake-server'
import { redirect } from 'next/navigation'
import OfferPrepareClientPicker from './picker-client'

export const dynamic = 'force-dynamic'

/**
 * Internal Offer Preparation — pick a client, then paste their WhatsApp offer
 * list and generate the designer sheet WITHOUT leaving the dashboard. This is
 * the employee-side twin of the public /intake/offer/[token] page: same form,
 * same actions, but reached by client instead of by token.
 *
 * Gated by the dedicated `offer.prepare` permission (admins bypass). Non-admins
 * without it are bounced to the dashboard.
 */
export default async function OfferPreparePage() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) redirect('/login')
  if (!me.isAdmin && !hasPermission(me, PERMS.OFFER_PREPARE)) redirect('/dashboard')

  const admin = createAdminClient()
  const [{ data: clientsRaw }, kindsByClient, { data: globalWebhookRow }] = await Promise.all([
    admin
      .from('clients')
      .select('id, name, code, offer_intake_token, offer_sheet_webhook_url, offer_sheet_url, has_offer_flyer_service')
      .eq('is_active', true)
      .order('name'),
    getIntakeKindsByClient(),
    admin.from('company_settings').select('value').eq('key', 'offer_sheet_webhook_url').maybeSingle(),
  ])
  const globalConfigured = !!(globalWebhookRow?.value || '').trim()

  // Same service-driven capability rule as the Offer Intake settings page.
  const clients = (clientsRaw || [])
    .filter(c =>
      (kindsByClient.get(c.id)?.includes('offer_intake') ?? false) || !!c.has_offer_flyer_service)
    .map(c => ({
      id: c.id,
      name: c.name,
      code: c.code,
      hasToken: !!c.offer_intake_token,
      // Sheet sync runs when the client has its own legacy script, or the
      // workspace-wide shared script is connected and this client's Sheet
      // link is set (same rule as the Offer Intake settings page).
      hasWebhook: !!c.offer_sheet_webhook_url || (globalConfigured && !!c.offer_sheet_url),
    }))
    .sort((a, b) => {
      const aSetup = a.hasToken && a.hasWebhook ? 1 : 0
      const bSetup = b.hasToken && b.hasWebhook ? 1 : 0
      if (aSetup !== bSetup) return bSetup - aSetup
      return a.name.localeCompare(b.name)
    })

  return <OfferPrepareClientPicker clients={clients} />
}
