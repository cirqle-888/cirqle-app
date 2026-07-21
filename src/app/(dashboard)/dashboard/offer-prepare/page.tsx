import { createAdminClient } from '@/lib/supabase/admin'
import { selectWithOptionalColumns } from '@/lib/offer-columns'
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
  const [clientsRaw, kindsByClient, { data: globalWebhookRow }] = await Promise.all([
    selectWithOptionalColumns<any[]>(
      'id, name, code, offer_intake_token, offer_sheet_webhook_url, offer_sheet_url, has_offer_flyer_service',
      ['offer_flow_mode', 'offer_master_sheet_url', 'integrations'],
      cols => admin.from('clients').select(cols).eq('is_active', true).order('name'),
    ),
    getIntakeKindsByClient(),
    admin.from('company_settings').select('value').eq('key', 'offer_sheet_webhook_url').maybeSingle(),
  ])
  const globalConfigured = !!(globalWebhookRow?.value || '').trim()

  // First Figma link per client, so staff can jump straight to the design.
  // Tolerates a missing table (migration not applied yet).
  const figmaByClient = new Map<string, string>()
  try {
    const { data: groupRows } = await admin
      .from('client_offer_groups')
      .select('client_id, integrations, display_order')
      .eq('is_active', true)
      .is('parent_id', null)
      .order('display_order')
    for (const row of groupRows || []) {
      const url = (row.integrations as any)?.figma?.file_url
      if (url && !figmaByClient.has(row.client_id)) figmaByClient.set(row.client_id, url)
    }
  } catch { /* pre-migration: no Figma links to show */ }

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
      flowMode: ((c as any).offer_flow_mode || 'push') as 'push' | 'pull' | 'manual',
      hasMasterSheet: !!(c as any).offer_master_sheet_url,
      // A category's Figma file wins; otherwise the client's own file.
      figmaUrl: figmaByClient.get(c.id)
        || ((c as any).integrations?.figma?.file_url as string | undefined)
        || null,
      sheetUrl: ((c as any).offer_master_sheet_url || c.offer_sheet_url || null) as string | null,
    }))
    .sort((a, b) => {
      // "Set up" depends on the mode, so pull-mode clients don't sink to the
      // bottom for lacking a designer sheet Cirqle never writes.
      const ready = (x: typeof a) =>
        x.flowMode === 'manual' ? 1
        : x.flowMode === 'pull' ? (x.hasMasterSheet ? 1 : 0)
        : (x.hasToken && x.hasWebhook ? 1 : 0)
      const aSetup = ready(a)
      const bSetup = ready(b)
      if (aSetup !== bSetup) return bSetup - aSetup
      return a.name.localeCompare(b.name)
    })

  return <OfferPrepareClientPicker clients={clients} />
}
