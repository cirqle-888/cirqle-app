/**
 * Cross-module rollups for the agency dashboard, alerts, reports and AI.
 *
 * Everything reads Cirqle's OWN normalized tables (social_account_insights_daily,
 * leads, ad_daily_metrics via ad_projects) — never the Meta API. All money in
 * INR. Ratios recomputed from summed raws (never averaged).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { ownerTypeOf } from '@/lib/assets/ownership'
import { toISODate } from '@/lib/utils/local-date'

/**
 * Does this row belong to a real client (as opposed to Cirqle, or nothing yet)?
 *
 * Uses the shared ownership rule so client isolation is defined in exactly one
 * place — see @/lib/assets/ownership and its cross-client leakage tests.
 */
function belongsToAnyClient(row: { owner_type?: string | null; client_id?: string | null }): boolean {
  return ownerTypeOf(row as never) === 'client' && !!row.client_id
}

export interface WindowPair<T> { cur: T; prev: T }

export interface ClientRollup {
  clientId: string
  clientName: string
  // Social (current window)
  reach: number
  views: number
  interactions: number
  followers: number | null
  contentPublished: number
  // Deltas vs previous equal window (percent, null if no prior data)
  reachDeltaPct: number | null
  // Leads
  leads: number
  leadsPrev: number
  leadsDeltaPct: number | null
  // Ads
  spend: number
  spendPrev: number
  adLeads: number
  cpl: number | null
  ctr: number | null
  roas: number | null
  // Health
  accountsConnected: number
  accountsNeedReauth: number
  syncFailures: number
  reportsPending: number
  health: 'green' | 'amber' | 'red'
}

export interface AgencyTotals {
  clients: number
  connectedAccounts: number
  totalReach: number
  totalViews: number
  totalLeads: number
  totalSpend: number
  avgCpl: number | null
  contentPublished: number
  reportsPending: number
  syncFailures: number
  accountsNeedReauth: number
  /**
   * Cirqle's OWN marketing, kept strictly beside the client figures above —
   * never folded into them. The agency needs to see its own performance; a
   * client total that quietly includes it is simply wrong.
   */
  cirqle: { accounts: number; reach: number; views: number; leads: number }
  /** Assets discovered but not yet assigned — in nobody's numbers until triaged. */
  unassignedAssets: number
}

function pct(cur: number, prev: number): number | null {
  if (!prev) return cur > 0 ? 100 : null
  return Math.round(((cur - prev) / prev) * 1000) / 10
}
const iso = (d: Date) => d.toISOString()
const isoDate = (d: Date) =>toISODate( d)

/**
 * Build a per-client rollup over `days` (with the previous equal window for
 * deltas). One batched query per table; aggregation in JS (row counts are small).
 */
export async function buildAgencyRollups(
  admin: SupabaseClient,
  days = 30,
): Promise<{ rollups: ClientRollup[]; totals: AgencyTotals }> {
  const now = new Date()
  const curFrom = new Date(now.getTime() - days * 86_400_000)
  const prevFrom = new Date(now.getTime() - 2 * days * 86_400_000)
  const curCutDate = isoDate(curFrom)

  const [clientsRes, accountsRes, insightsRes, leadsRes, projectsRes, metricsRes, reportsRes] = await Promise.all([
    admin.from('clients').select('id, name').eq('is_active', true),
    // owner_type is selected so Cirqle's own and untriaged assets can be kept
    // OUT of client rollups below — a client total must never include them.
    // owner_type is selected so Cirqle's own and untriaged assets stay OUT of
    // client rollups. Falls back to the pre-migration shape rather than failing
    // the whole dashboard if the column is not there yet.
    admin.from('social_accounts').select('id, client_id, owner_type, status, last_synced_at').neq('status', 'disconnected')
      .then(r => r.error ? admin.from('social_accounts').select('id, client_id, status, last_synced_at').neq('status', 'disconnected') : r),
    admin.from('social_account_insights_daily').select('account_id, metric_date, reach, views, total_interactions, followers_count').gte('metric_date', isoDate(prevFrom)),
    admin.from('leads').select('client_id, owner_type, created_at').gte('created_at', iso(prevFrom))
      .then(r => r.error ? admin.from('leads').select('client_id, created_at').gte('created_at', iso(prevFrom)) : r),
    admin.from('ad_projects').select('id, client_id').is('deleted_at', null),
    admin.from('ad_daily_metrics').select('project_id, metric_date, spend, revenue, impressions, clicks, leads').gte('metric_date', isoDate(prevFrom)),
    admin.from('ad_reports').select('id, status').in('status', ['generating', 'pending']).then((r) => r, () => ({ data: [] as any[] })),
  ])

  const clients = (clientsRes.data ?? []) as { id: string; name: string }[]
  const accounts = (accountsRes.data ?? []) as any[]

  // Three buckets, no overlap — see @/lib/assets/ownership and its tests.
  const cirqleAccountIds = new Set(
    accounts.filter(a => ownerTypeOf(a) === 'cirqle').map(a => a.id as string),
  )
  const unassignedAssets = accounts.filter(a => ownerTypeOf(a) === 'unassigned').length
  const socialPublished = await admin
    .from('social_posts')
    .select('client_id')
    .eq('status', 'published')
    .gte('published_at', iso(curFrom))
    .then((r) => (r.data ?? []) as { client_id: string }[], () => [])

  // account_id → client_id, for CLIENT-owned accounts only.
  //
  // An account owned by Cirqle, or not yet triaged, contributes to no client.
  // Leaving it out here is what keeps agency reach/leads totals honest: an
  // asset reclassified as Cirqle's keeps its old client_id, so filtering on
  // client_id alone would still leak it.
  const accountClient = new Map<string, string>()
  for (const a of accounts) {
    if (!belongsToAnyClient(a)) continue
    accountClient.set(a.id, a.client_id)
  }
  // project_id → client_id
  const projectClient = new Map<string, string>()
  for (const p of (projectsRes.data ?? []) as any[]) projectClient.set(p.id, p.client_id)

  const blank = (): ClientRollup => ({
    clientId: '', clientName: '', reach: 0, views: 0, interactions: 0, followers: null,
    contentPublished: 0, reachDeltaPct: null, leads: 0, leadsPrev: 0, leadsDeltaPct: null,
    spend: 0, spendPrev: 0, adLeads: 0, cpl: null, ctr: null, roas: null,
    accountsConnected: 0, accountsNeedReauth: 0, syncFailures: 0, reportsPending: 0, health: 'green',
  })
  const map = new Map<string, ClientRollup>()
  for (const c of clients) map.set(c.id, { ...blank(), clientId: c.id, clientName: c.name })

  // Social insights → reach/views/interactions (cur), reachPrev for delta, followers latest
  const reachPrevByClient = new Map<string, number>()
  const impByProjectCur: Record<string, never> = {} as never
  for (const row of (insightsRes.data ?? []) as any[]) {
    const clientId = accountClient.get(row.account_id)
    if (!clientId) continue
    const r = map.get(clientId)
    if (!r) continue
    const isCur = String(row.metric_date) >= curCutDate
    const reach = Number(row.reach ?? 0)
    if (isCur) {
      r.reach += reach
      r.views += Number(row.views ?? 0)
      r.interactions += Number(row.total_interactions ?? 0)
      if (row.followers_count != null) r.followers = Number(row.followers_count)
    } else {
      reachPrevByClient.set(clientId, (reachPrevByClient.get(clientId) ?? 0) + reach)
    }
  }
  for (const [clientId, r] of map) r.reachDeltaPct = pct(r.reach, reachPrevByClient.get(clientId) ?? 0)

  // Leads cur/prev
  for (const row of (leadsRes.data ?? []) as any[]) {
    if (!belongsToAnyClient(row)) continue
    const r = map.get(row.client_id)
    if (!r) continue
    if (iso(new Date(row.created_at)) >= iso(curFrom)) r.leads += 1
    else r.leadsPrev += 1
  }
  for (const r of map.values()) r.leadsDeltaPct = pct(r.leads, r.leadsPrev)

  // Ads: spend/impressions/clicks/leads/revenue cur & prev
  const adAcc = new Map<string, { spend: number; imp: number; clicks: number; leads: number; rev: number }>()
  const adAccPrev = new Map<string, { spend: number }>()
  for (const row of (metricsRes.data ?? []) as any[]) {
    const clientId = projectClient.get(row.project_id)
    if (!clientId) continue
    const isCur = String(row.metric_date) >= curCutDate
    if (isCur) {
      const cur = adAcc.get(clientId) ?? { spend: 0, imp: 0, clicks: 0, leads: 0, rev: 0 }
      cur.spend += Number(row.spend ?? 0)
      cur.imp += Number(row.impressions ?? 0)
      cur.clicks += Number(row.clicks ?? 0)
      cur.leads += Number(row.leads ?? 0)
      cur.rev += Number(row.revenue ?? 0)
      adAcc.set(clientId, cur)
    } else {
      const prev = adAccPrev.get(clientId) ?? { spend: 0 }
      prev.spend += Number(row.spend ?? 0)
      adAccPrev.set(clientId, prev)
    }
  }
  for (const [clientId, r] of map) {
    const a = adAcc.get(clientId)
    if (a) {
      r.spend = Math.round(a.spend)
      r.adLeads = a.leads
      r.cpl = a.leads > 0 ? Math.round((a.spend / a.leads) * 100) / 100 : null
      r.ctr = a.imp > 0 ? Math.round((a.clicks / a.imp) * 10000) / 100 : null
      r.roas = a.spend > 0 ? Math.round((a.rev / a.spend) * 100) / 100 : null
    }
    r.spendPrev = Math.round(adAccPrev.get(clientId)?.spend ?? 0)
  }

  // Content published (social_posts)
  for (const p of socialPublished) {
    const r = map.get(p.client_id)
    if (r) r.contentPublished += 1
  }

  // Health: account counts + sync staleness
  const staleCut = Date.now() - 24 * 3_600_000
  for (const a of accounts) {
    const r = map.get(a.client_id)
    if (!r) continue
    r.accountsConnected += 1
    if (a.status === 'needs_reauth' || a.status === 'error') r.accountsNeedReauth += 1
    const synced = a.last_synced_at ? new Date(a.last_synced_at).getTime() : 0
    if (!synced || synced < staleCut) r.syncFailures += 1
  }
  for (const r of map.values()) {
    if (r.accountsNeedReauth > 0) r.health = 'red'
    else if (r.syncFailures > 0 || (r.reachDeltaPct != null && r.reachDeltaPct < -40) || (r.cpl != null && r.cpl > 1000)) r.health = 'amber'
    else r.health = 'green'
  }

  const rollups = Array.from(map.values()).sort((a, b) => (b.reach + b.spend) - (a.reach + a.spend))

  // Totals
  const totalSpend = rollups.reduce((t, r) => t + r.spend, 0)
  const totalAdLeads = rollups.reduce((t, r) => t + r.adLeads, 0)
  // Cirqle's own reach/views, summed from the SAME insight rows the client
  // rollups used — but only for accounts we own, and kept out of every client
  // figure above.
  let cirqleReach = 0, cirqleViews = 0
  for (const row of (insightsRes.data ?? []) as any[]) {
    if (!cirqleAccountIds.has(row.account_id)) continue
    if (String(row.metric_date) < curCutDate) continue
    cirqleReach += Number(row.reach ?? 0)
    cirqleViews += Number(row.views ?? 0)
  }
  const cirqleLeads = ((leadsRes.data ?? []) as any[])
    .filter(r => (r.owner_type ?? 'client') === 'cirqle' && iso(curFrom) <= String(r.created_at))
    .length

  const totals: AgencyTotals = {
    clients: clients.length,
    connectedAccounts: accounts.filter((a) => a.status === 'connected').length,
    totalReach: rollups.reduce((t, r) => t + r.reach, 0),
    totalViews: rollups.reduce((t, r) => t + r.views, 0),
    totalLeads: rollups.reduce((t, r) => t + r.leads, 0),
    totalSpend,
    avgCpl: totalAdLeads > 0 ? Math.round((totalSpend / totalAdLeads) * 100) / 100 : null,
    contentPublished: rollups.reduce((t, r) => t + r.contentPublished, 0),
    reportsPending: ((reportsRes as any).data ?? []).length,
    syncFailures: rollups.reduce((t, r) => t + r.syncFailures, 0),
    accountsNeedReauth: rollups.reduce((t, r) => t + r.accountsNeedReauth, 0),
    cirqle: {
      accounts: cirqleAccountIds.size,
      reach: cirqleReach,
      views: cirqleViews,
      leads: cirqleLeads,
    },
    unassignedAssets,
  }

  return { rollups, totals }
}

/** Single-client fact bundle for reports + AI (both windows + top content + leads). */
export async function buildClientFacts(admin: SupabaseClient, clientId: string, days = 30) {
  const { rollups } = await buildAgencyRollups(admin, days)
  const roll = rollups.find((r) => r.clientId === clientId) ?? null

  const [accounts, topContent, forms] = await Promise.all([
    admin.from('social_accounts').select('id, platform, name, username, followers_count, status').eq('client_id', clientId).neq('status', 'disconnected'),
    admin.from('social_media_items').select('caption, media_product_type, reach, views, likes, comments, shares, saves, total_interactions, engagement_rate, permalink, posted_at, account_id')
      .in('account_id', (await admin.from('social_accounts').select('id').eq('client_id', clientId)).data?.map((a: any) => a.id) ?? ['none'])
      .gte('posted_at', new Date(Date.now() - days * 86_400_000).toISOString())
      .order('reach', { ascending: false, nullsFirst: false })
      .limit(10),
    admin.from('leads').select('campaign_name, status').eq('client_id', clientId).gte('created_at', new Date(Date.now() - days * 86_400_000).toISOString()),
  ])

  // Leads by campaign
  const leadsByCampaign: Record<string, number> = {}
  for (const l of (forms.data ?? []) as any[]) {
    const k = l.campaign_name || 'Direct / organic'
    leadsByCampaign[k] = (leadsByCampaign[k] ?? 0) + 1
  }

  return {
    rollup: roll,
    accounts: (accounts.data ?? []) as any[],
    topContent: (topContent.data ?? []) as any[],
    leadsByCampaign,
    days,
  }
}
