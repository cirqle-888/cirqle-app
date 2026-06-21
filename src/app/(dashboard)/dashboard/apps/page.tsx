import { resolveCurrentEmployeeId } from '@/lib/auth/enforce'
import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { getIntakeKindsByClient } from '@/lib/services/intake-server'
import AppsClient from './apps-client'

export const dynamic = 'force-dynamic'

export default async function AppsDirectoryPage() {
  // Route is permission-gated by middleware (/^\/dashboard\/settings/ → settings.access).
  const employeeId = await resolveCurrentEmployeeId()
  if (!employeeId) redirect('/login')

  // Per-intake-kind enabled-client counts, derived from assigned services.
  const kindsByClient = await getIntakeKindsByClient()
  const clientCounts: Record<string, number> = {}
  for (const kinds of kindsByClient.values()) {
    for (const k of kinds) clientCounts[k] = (clientCounts[k] || 0) + 1
  }

  // Clients with 2+ intake apps enabled — these are the ones who actually
  // need the single Client Hub link instead of one app's direct link.
  const multiServiceIds = [...kindsByClient.entries()].filter(([, kinds]) => kinds.length > 1).map(([id]) => id)
  let multiServiceClients: { id: string; name: string; phone: string | null; hub_token: string; kinds: string[] }[] = []
  if (multiServiceIds.length) {
    try {
      const admin = createAdminClient()
      const { data, error } = await admin.from('clients').select('id, name, phone, hub_token').in('id', multiServiceIds).order('name')
      if (!error) multiServiceClients = (data || []).map(c => ({ ...c, kinds: kindsByClient.get(c.id) || [] }))
    } catch { /* hub_token migration not applied yet */ }
  }

  return <AppsClient clientCounts={clientCounts} multiServiceClients={multiServiceClients} />
}
