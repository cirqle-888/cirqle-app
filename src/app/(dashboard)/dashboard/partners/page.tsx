import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { listPartners, listPartnerSummaries } from '@/lib/partners/queries'
import PartnersClient from './partners-client'

export const dynamic = 'force-dynamic'

export default async function PartnersPage() {
  // Route is permission-gated by middleware (`finance.partner.view`).
  const me = await loadCurrentUser().catch(() => null)
  const supabase = createAdminClient()

  const [partners, unlinkedClientsRes, summaries] = await Promise.all([
    listPartners(),
    supabase.from('clients').select('id, name, code, business_partner_id').eq('is_active', true).order('name'),
    listPartnerSummaries(),
  ])

  return (
    <PartnersClient
      initialPartners={partners}
      allClients={unlinkedClientsRes.data || []}
      summaries={summaries}
      canCreate={hasPermission(me, PERMS.PARTNERS_CREATE)}
      canEdit={hasPermission(me, PERMS.PARTNERS_EDIT)}
    />
  )
}
