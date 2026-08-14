import { redirect } from 'next/navigation'
import { createAdminClient, columnExists } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import LeadsClient from './leads-client'

export const dynamic = 'force-dynamic'

/**
 * Leads CRM — every lead the agency captures for its clients (Meta Lead Ads
 * via the webhook, plus manual/import/website entries), in one pipeline.
 *
 * Server page: guard → filtered queries → plain props. All interactivity
 * lives in leads-client.tsx; all writes in actions.ts.
 */
export default async function LeadsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canView = isAdmin || hasPermission(me, PERMS.LEADS_VIEW) || !me
  if (me && !canView) redirect('/dashboard')
  const canManage = isAdmin || hasPermission(me, PERMS.LEADS_MANAGE)

  const sp = searchParams ? await searchParams : undefined
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''
  const statusParam = first(sp?.status)
  const clientParam = first(sp?.client)
  const assignedParam = first(sp?.assigned)
  const qParam = first(sp?.q).trim()

  const supabase = createAdminClient()

  // Client CRM: Cirqle's own lead-ad leads belong on Cirqle Accounts, not here.
  // Probed rather than assumed so this file is safe to deploy BEFORE the
  // ownership migration — without the column every lead is client-owned, which
  // is exactly the behaviour that existed before.
  const hasOwnerType = await columnExists(supabase, 'leads', 'owner_type')

  // Latest 500 leads, filtered by the URL params (deep-linkable).
  let leadsQuery = supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500)
  if (hasOwnerType) leadsQuery = leadsQuery.eq('owner_type', 'client')
  if (statusParam) leadsQuery = leadsQuery.eq('status', statusParam)
  if (clientParam) leadsQuery = leadsQuery.eq('client_id', clientParam)
  if (assignedParam === 'unassigned') leadsQuery = leadsQuery.is('assigned_to', null)
  else if (assignedParam) leadsQuery = leadsQuery.eq('assigned_to', assignedParam)
  if (qParam) {
    const like = `%${qParam.replaceAll(',', ' ')}%`
    leadsQuery = leadsQuery.or(`full_name.ilike.${like},email.ilike.${like},phone.ilike.${like}`)
  }

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()

  const [leadsRes, clientsRes, employeesRes, rulesRes, recentRes, totalRes] = await Promise.all([
    leadsQuery,
    supabase.from('clients').select('id, name, is_active').order('name'),
    supabase.from('employees').select('id, cqid, name').eq('is_active', true).order('cqid'),
    supabase
      .from('lead_automation_rules')
      .select('*')
      .order('display_order')
      .order('created_at'),
    // Minimal columns — the 30-day KPI strip only needs status + source.
    (hasOwnerType
      ? supabase.from('leads').select('status, source').eq('owner_type', 'client')
      : supabase.from('leads').select('status, source')
    ).gte('created_at', since30d).limit(10000),
    hasOwnerType
      ? supabase.from('leads').select('id', { count: 'exact', head: true }).eq('owner_type', 'client')
      : supabase.from('leads').select('id', { count: 'exact', head: true }),
  ])

  // KPI rollups computed server-side so the client component stays lean.
  const statusCounts: Record<string, number> = { new: 0, contacted: 0, qualified: 0, won: 0, lost: 0 }
  const sourceCounts: Record<string, number> = {}
  for (const row of (recentRes.data || []) as { status: string; source: string }[]) {
    if (row.status in statusCounts) statusCounts[row.status] += 1
    sourceCounts[row.source] = (sourceCounts[row.source] || 0) + 1
  }

  return (
    <LeadsClient
      leads={(leadsRes.data || []) as never[]}
      clients={(clientsRes.data || []) as never[]}
      employees={(employeesRes.data || []) as never[]}
      rules={(rulesRes.data || []) as never[]}
      statusCounts30d={statusCounts}
      sourceCounts30d={sourceCounts}
      totalLeads={totalRes.count ?? (leadsRes.data || []).length}
      canManage={canManage}
      initialFilters={{ status: statusParam, client: clientParam, assigned: assignedParam, q: qParam }}
    />
  )
}
