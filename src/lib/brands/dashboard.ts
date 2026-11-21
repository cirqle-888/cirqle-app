/**
 * Everything the Brands pages show, per brand: accounts, audience, leads,
 * company campaigns, internal work and (gated) money.
 *
 * Server-only (admin client). Each read is independently best-effort, so a
 * missing table or column removes one figure, never the page. Money is only
 * READ when `withMoney` is true — the caller gates it on company financials, so
 * figures a viewer may not see never leave the server.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { addDaysISO, monthStartISO, monthEndISO, todayISO } from '@/lib/utils/local-date'
import { brandKey, type Brand } from './brands'
import { computeBrandPnl, type BrandPnlRow } from './pnl'

export type BrandPeriod = '30d' | 'month' | 'last-month' | 'year'

export const BRAND_PERIODS: { value: BrandPeriod; label: string }[] = [
  { value: '30d', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'year', label: 'This year' },
]

export function resolveBrandPeriod(raw: string | null | undefined): { period: BrandPeriod; from: string; to: string } {
  const today = todayISO()
  switch (raw) {
    case 'month':      return { period: 'month', from: monthStartISO(0), to: today }
    case 'last-month': return { period: 'last-month', from: monthStartISO(-1), to: monthEndISO(-1) }
    case 'year':       return { period: 'year', from: `${today.slice(0, 4)}-01-01`, to: today }
    default:           return { period: '30d', from: addDaysISO(today, -29), to: today }
  }
}

export interface BrandAccount {
  id: string
  platform: string
  name: string
  username: string | null
  external_id: string
  followers: number | null
  status: string | null
}

export interface BrandCampaign {
  id: string
  campaign_name: string
  status: string
  platform: string
  start_date: string | null
  end_date: string | null
  spendInclGstInr: number | null
}

export interface BrandTask {
  id: string
  task_number: number | null
  title: string
  status: string
  task_date: string | null
}

export interface BrandSummary {
  brand: Brand
  accounts: BrandAccount[]
  followers: number
  reach: number
  views: number
  interactions: number
  leads: number
  campaigns: BrandCampaign[]
  activeCampaigns: number
  openTasks: BrandTask[]
  services: { id: string; name: string }[]
  pnl: BrandPnlRow | null
}

const OPEN_TASK_EXCLUDED = ['completed', 'done', 'invoiced', 'cancelled', 'paid']

type Rows<T> = { data: T[] | null; error?: unknown }
const safe = async <T,>(p: PromiseLike<Rows<T>>): Promise<T[]> => {
  try { const r = await p; return r.error ? [] : (r.data ?? []) } catch { return [] }
}

async function inChunks<T>(ids: string[], read: (chunk: string[]) => PromiseLike<Rows<T>>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += 200) out.push(...await safe(read(ids.slice(i, i + 200))))
  return out
}

export async function loadBrandSummaries(
  admin: SupabaseClient,
  brands: Brand[],
  opts: { from: string; to: string; withMoney: boolean },
): Promise<BrandSummary[]> {
  if (!brands.length) return []
  const { from, to, withMoney } = opts
  const key = (id: string | null | undefined) => brandKey(id, brands)

  // ── Accounts (Cirqle-owned only) ─────────────────────────────────────────
  const accounts = await safe(admin.from('social_accounts')
    .select('id, platform, name, username, external_id, followers_count, status, brand_id, owner_type')
    .eq('owner_type', 'cirqle') as unknown as PromiseLike<Rows<any>>)
  const accountBrand = new Map<string, string | null>(accounts.map(a => [a.id, key(a.brand_id)]))
  const pageBrandByExternal = new Map<string, string | null>(accounts.map(a => [String(a.external_id), key(a.brand_id)]))

  // ── Audience in the period ───────────────────────────────────────────────
  const insights = accounts.length
    ? await inChunks(accounts.map(a => a.id), ids => admin.from('social_account_insights_daily')
        .select('account_id, reach, views, total_interactions')
        .in('account_id', ids).gte('metric_date', from).lte('metric_date', to) as unknown as PromiseLike<Rows<any>>)
    : []

  // ── Leads captured on the brand's pages ──────────────────────────────────
  const leads = await safe(admin.from('leads')
    .select('social_account_id, page_external_id, submitted_at, created_at')
    .eq('owner_type', 'cirqle')
    .gte('created_at', `${from}T00:00:00`).lte('created_at', `${to}T23:59:59`) as unknown as PromiseLike<Rows<any>>)

  // ── Company campaigns ────────────────────────────────────────────────────
  const campaigns = await safe(admin.from('ad_projects')
    .select('id, campaign_name, status, platform, start_date, end_date, client_id, brand_id, page_account_id, archived_at')
    .is('client_id', null).is('deleted_at', null)
    .order('created_at', { ascending: false }).limit(300) as unknown as PromiseLike<Rows<any>>)
  // A campaign with no brand of its own takes its page's brand.
  const campaignBrand = (c: any) => c.brand_id ? key(c.brand_id)
    : c.page_account_id && accountBrand.has(c.page_account_id) ? accountBrand.get(c.page_account_id)! : key(null)

  const spendByCampaign = new Map<string, number>()
  if (withMoney && campaigns.length) {
    const metrics = await inChunks(campaigns.map(c => c.id), ids => admin.from('ad_daily_metrics')
      .select('project_id, spend').in('project_id', ids)
      .gte('metric_date', from).lte('metric_date', to) as unknown as PromiseLike<Rows<any>>)
    for (const m of metrics) spendByCampaign.set(m.project_id, (spendByCampaign.get(m.project_id) || 0) + Number(m.spend || 0))
  }

  // ── Internal work ────────────────────────────────────────────────────────
  const internalTasks = await safe(admin.from('tasks')
    .select('id, task_number, title, status, task_date, brand_id')
    .is('client_id', null).is('deleted_at', null)
    .not('status', 'in', `(${OPEN_TASK_EXCLUDED.map(s => `"${s}"`).join(',')})`)
    .order('task_date', { ascending: false }).limit(500) as unknown as PromiseLike<Rows<any>>)

  // ── Services each brand sells ────────────────────────────────────────────
  const services = await safe(admin.from('services')
    .select('id, name, brand_id, is_active').eq('is_active', true).order('name') as unknown as PromiseLike<Rows<any>>)
  const serviceBrand = new Map<string, string | null>(services.map(s => [s.id, s.brand_id ?? null]))

  // ── Money (gated) ────────────────────────────────────────────────────────
  let pnlRows: BrandPnlRow[] = []
  if (withMoney) {
    const tasks = await safe(admin.from('tasks')
      .select('id, client_id, service_id, billing_amount_inr, is_billable')
      .gte('task_date', from).lte('task_date', to).is('deleted_at', null)
      .not('client_id', 'is', null).limit(10000) as unknown as PromiseLike<Rows<any>>)
    const earningsByTask = new Map<string, number>()
    const scores = await inChunks(tasks.map(t => t.id), ids => admin.from('contribution_scores')
      .select('task_id, earnings_inr').in('task_id', ids) as unknown as PromiseLike<Rows<any>>)
    for (const s of scores) earningsByTask.set(s.task_id, (earningsByTask.get(s.task_id) || 0) + Number(s.earnings_inr || 0))

    const entries = await safe(admin.from('cashbook_entries')
      .select('id, type, amount_inr, brand_id, scope, client_id')
      .not('brand_id', 'is', null).is('deleted_at', null)
      .gte('entry_date', from).lte('entry_date', to) as unknown as PromiseLike<Rows<any>>)
    const funding = entries.length
      ? await inChunks(entries.map(e => e.id), ids => admin.from('ad_wallet_ledger')
          .select('cashbook_entry_id').eq('direction', 'credit').is('deleted_at', null)
          .in('cashbook_entry_id', ids) as unknown as PromiseLike<Rows<any>>)
      : []

    pnlRows = computeBrandPnl({
      brands,
      serviceBrand,
      tasks,
      earningsByTask,
      campaigns: campaigns.map(c => ({ id: c.id, client_id: null, brand_id: campaignBrand(c) })),
      spendByCampaign,
      entries,
      walletFundingEntryIds: new Set(funding.map(f => f.cashbook_entry_id)),
    })
  }

  return brands.map(brand => {
    const mine = accounts.filter(a => accountBrand.get(a.id) === brand.id)
    const mineIds = new Set(mine.map(a => a.id))
    const ins = insights.filter(i => mineIds.has(i.account_id))
    const myCampaigns = campaigns.filter(c => campaignBrand(c) === brand.id)
    return {
      brand,
      accounts: mine.map(a => ({
        id: a.id, platform: a.platform, name: a.name, username: a.username ?? null,
        external_id: String(a.external_id), followers: a.followers_count ?? null, status: a.status ?? null,
      })),
      followers: mine.reduce((s, a) => s + Number(a.followers_count || 0), 0),
      reach: ins.reduce((s, i) => s + Number(i.reach || 0), 0),
      views: ins.reduce((s, i) => s + Number(i.views || 0), 0),
      interactions: ins.reduce((s, i) => s + Number(i.total_interactions || 0), 0),
      leads: leads.filter(l =>
        (l.social_account_id && accountBrand.get(l.social_account_id) === brand.id) ||
        (!l.social_account_id && l.page_external_id && pageBrandByExternal.get(String(l.page_external_id)) === brand.id)).length,
      campaigns: myCampaigns.map(c => ({
        id: c.id, campaign_name: c.campaign_name, status: c.status, platform: c.platform,
        start_date: c.start_date ?? null, end_date: c.end_date ?? null,
        spendInclGstInr: withMoney ? Math.round((spendByCampaign.get(c.id) || 0) * 1.18 * 100) / 100 : null,
      })),
      activeCampaigns: myCampaigns.filter(c => c.status === 'active' && !c.archived_at).length,
      openTasks: internalTasks.filter(t => key(t.brand_id) === brand.id).map(t => ({
        id: t.id, task_number: t.task_number ?? null, title: t.title, status: t.status, task_date: t.task_date ?? null,
      })),
      services: services.filter(s => key(s.brand_id) === brand.id).map(s => ({ id: s.id, name: s.name })),
      pnl: withMoney ? pnlRows.find(r => r.brandId === brand.id) ?? null : null,
    }
  })
}
