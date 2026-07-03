import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import AdvertisingClient from './advertising-client'

export const dynamic = 'force-dynamic'

/**
 * Advertising dashboard. Defensive by design (mirrors requests/page.tsx): if the
 * ad_* tables haven't been migrated yet, `migrated` flips false and the client
 * shows a one-time "run the migration" notice instead of crashing.
 */
export default async function AdvertisingPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true
  const canView = isAdmin || hasPermission(me, PERMS.ADVERTISING_VIEW)
  if (me && !canView) redirect('/dashboard')

  const admin = createAdminClient()

  let projects: any[] = []
  let migrated = true
  try {
    const { data, error } = await admin
      .from('ad_projects')
      .select('*, client:clients(id, name, code)')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) migrated = false
    projects = data || []
  } catch { migrated = false }

  // Aggregate-able daily rows per project (defensive — table may be empty/missing).
  const metricsByProject: Record<string, any[]> = {}
  if (migrated && projects.length) {
    try {
      const ids = projects.map(p => p.id)
      const { data: metrics } = await admin
        .from('ad_daily_metrics')
        .select('project_id, spend, revenue, impressions, clicks, reach, leads, metric_date')
        .in('project_id', ids)
      for (const m of metrics || []) (metricsByProject[(m as any).project_id] ||= []).push(m)
    } catch { /* metrics table not migrated */ }
  }

  const clients = (await admin.from('clients').select('id, name, code').order('name')).data || []

  // ── Client wallet ledger (best-effort — migration 20260703140000) ──────────
  // One fetch powers balances, per-campaign allocations, and the history panel.
  let walletSupported = true
  let ledger: any[] = []
  try {
    const { data, error } = await admin
      .from('ad_wallet_ledger')
      .select(`
        id, client_id, direction, kind, ad_project_id, cashbook_entry_id,
        amount, amount_inr, notes, created_at,
        creator:employees(id, name),
        entry:cashbook_entries(id, entry_date, description, reference),
        project:ad_projects(id, campaign_name)
      `)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(1000)
    if (error) walletSupported = false
    ledger = data || []
  } catch { walletSupported = false }

  // Candidate funding entries for "Add funds": recent outflows + how much of
  // each is still uncredited to any wallet.
  let fundCandidates: any[] = []
  if (walletSupported) {
    try {
      const { data: outflows } = await admin
        .from('cashbook_entries')
        .select('id, entry_date, description, reference, amount, amount_inr, currency')
        .eq('type', 'outflow').is('deleted_at', null)
        .order('entry_date', { ascending: false }).limit(100)
      const entries = outflows || []
      let creditedByEntry: Record<string, number> = {}
      if (entries.length > 0) {
        const { data: credits } = await admin
          .from('ad_wallet_ledger').select('cashbook_entry_id, amount')
          .eq('direction', 'credit').is('deleted_at', null)
          .in('cashbook_entry_id', entries.map((e: any) => e.id))
        creditedByEntry = (credits || []).reduce((acc: Record<string, number>, r: any) => {
          acc[r.cashbook_entry_id] = (acc[r.cashbook_entry_id] || 0) + Number(r.amount || 0)
          return acc
        }, {})
      }
      fundCandidates = entries.map((e: any) => ({
        ...e,
        uncredited: Math.round((Number(e.amount || 0) - (creditedByEntry[e.id] || 0)) * 100) / 100,
      }))
    } catch { /* cashbook not readable — Add Funds simply shows no candidates */ }
  }

  // Advertising requests waiting to be started (they also show in the Requests
  // inbox). Defensive: the ad_meta column ships in a later migration.
  let pendingRequests: any[] = []
  try {
    const { data } = await admin
      .from('task_requests')
      .select('id, ref_no, title, created_at, ad_meta, client:clients(id, name)')
      .not('ad_meta', 'is', null)
      .is('promoted_task_id', null)
      .not('status', 'in', '("rejected","archived")')
      .order('created_at', { ascending: false })
      .limit(50)
    pendingRequests = data || []
  } catch { /* ad_meta not migrated */ }

  const perms = {
    create:       isAdmin || hasPermission(me, PERMS.ADVERTISING_CREATE),
    edit:         isAdmin || hasPermission(me, PERMS.ADVERTISING_EDIT),
    manageBudget: isAdmin || hasPermission(me, PERMS.ADVERTISING_MANAGE_BUDGET),
  }

  return (
    <AdvertisingClient
      migrated={migrated}
      initialProjects={projects}
      metricsByProject={metricsByProject}
      pendingRequests={pendingRequests}
      clients={clients}
      walletSupported={walletSupported}
      ledger={ledger}
      fundCandidates={fundCandidates}
      perms={perms}
    />
  )
}
