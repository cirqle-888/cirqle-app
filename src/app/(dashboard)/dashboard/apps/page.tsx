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
  let multiServiceClients: { id: string; name: string; phone: string | null; hub_token: string; kinds: string[]; lastActivity: string | null; requestCount: number }[] = []
  if (multiServiceIds.length) {
    try {
      const admin = createAdminClient()
      const { data, error } = await admin.from('clients').select('id, name, phone, hub_token').in('id', multiServiceIds).order('name')

      // Recency + frequency of submissions across both apps, so the busiest /
      // most-recently-active clients surface at the top of the list.
      const activity = new Map<string, { last: string; count: number }>()
      try {
        const [reqRes, offerRes] = await Promise.all([
          admin.from('task_requests').select('client_id, created_at').in('client_id', multiServiceIds),
          admin.from('offer_campaigns').select('client_id, created_at').in('client_id', multiServiceIds),
        ])
        for (const r of [...(reqRes.data || []), ...(offerRes.data || [])] as { client_id: string; created_at: string }[]) {
          if (!r.client_id) continue
          const e = activity.get(r.client_id)
          if (!e) activity.set(r.client_id, { last: r.created_at, count: 1 })
          else { e.count += 1; if (r.created_at > e.last) e.last = r.created_at }
        }
      } catch { /* offer_campaigns / task_requests may not exist pre-migration */ }

      if (!error) {
        multiServiceClients = (data || [])
          .map(c => {
            const a = activity.get(c.id)
            return { ...c, kinds: kindsByClient.get(c.id) || [], lastActivity: a?.last || null, requestCount: a?.count || 0 }
          })
          .sort((a, b) =>
            a.lastActivity && b.lastActivity ? b.lastActivity.localeCompare(a.lastActivity)
            : a.lastActivity ? -1
            : b.lastActivity ? 1
            : b.requestCount - a.requestCount,
          )
      }
    } catch { /* hub_token migration not applied yet */ }
  }

  return <AppsClient clientCounts={clientCounts} multiServiceClients={multiServiceClients} />
}
