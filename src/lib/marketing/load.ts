/* eslint-disable @typescript-eslint/no-explicit-any -- rows from the untyped Supabase client; each is narrowed into the Hub* interfaces below before it leaves this file. */
/**
 * Client Marketing Hub — data loaders.
 *
 * Read-only. Every figure comes from the same tables the individual modules
 * use (Social, Advertising, Leads, Social Calendar, Asset Assignment), and the
 * ownership rule from @/lib/assets/ownership keeps Cirqle's own and untriaged
 * assets out of every client. Each read is guarded: a table that is missing
 * in an older environment contributes nothing instead of failing the page.
 *
 * SECURITY: access tokens are never selected.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildAgencyRollups } from '@/lib/integrations/meta/aggregate'
import { ownerTypeOf } from '@/lib/assets/ownership'
import { addDaysISO } from '@/lib/utils/local-date'
import { planProgress, monthStartISO, type PlanProgress, type PlanItemLike } from './hub'

// ── Shared selects ──────────────────────────────────────────────────────────

/** Plan items with just enough of the request/task chain to resolve progress. */
const ITEM_PROGRESS = `
  status,
  request:task_requests!social_calendar_items_request_id_fkey(status, promoted_task:tasks!task_requests_promoted_task_id_fkey(status))
`
const ITEM_TASK = `task:tasks!social_calendar_items_task_id_fkey(status, deleted_at)`

/**
 * Plans with their items' progress. The direct-task embed needs a later
 * migration, so a failure retries without it rather than losing every plan.
 */
async function loadPlans(admin: SupabaseClient, filter: { clientId?: string; month?: string }, extraItemCols = '') {
  const run = (withTask: boolean) => {
    let q = admin.from('social_calendars').select(
      `id, client_id, month, title, status,
       items:social_calendar_items(${ITEM_PROGRESS}${withTask ? `, ${ITEM_TASK}` : ''}${extraItemCols ? `, ${extraItemCols}` : ''})`,
    ).neq('status', 'archived')
    if (filter.clientId) q = q.eq('client_id', filter.clientId)
    if (filter.month) q = q.eq('month', filter.month)
    return q.order('month', { ascending: false }).limit(200)
  }
  let res = await run(true)
  if (res.error) res = await run(false)
  return (res.data ?? []) as any[]
}

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null)

// ── Client list ─────────────────────────────────────────────────────────────

export interface DirectoryEntry {
  id: string
  name: string
  code: string | null
  isActive: boolean
  pages: number
  instagram: number
  facebook: number
  followers: number | null
  liveCampaigns: number
  activeCampaigns: number
  plan: { id: string; title: string | null; progress: PlanProgress } | null
  hasPlan: boolean
  reach30: number
  spend30: number
  leads30: number
  health: 'green' | 'amber' | 'red'
  issues: string[]
}

export interface MarketingDirectory {
  clients: DirectoryEntry[]
  unassignedAssets: number
  cirqleAccounts: number
  month: string
}

export async function loadMarketingDirectory(admin: SupabaseClient, today: string): Promise<MarketingDirectory> {
  const month = monthStartISO(today)
  const [clientsRes, accountsRes, projectsRes, plans, agency] = await Promise.all([
    admin.from('clients').select('id, name, code, is_active').order('name'),
    admin.from('social_accounts').select('id, client_id, owner_type, platform, status, followers_count')
      .neq('status', 'disconnected')
      .then(r => r, () => ({ data: [] as any[] })),
    admin.from('ad_projects').select('id, client_id, status, archived_at').is('deleted_at', null)
      .then(r => r, () => ({ data: [] as any[] })),
    loadPlans(admin, { month }).catch(() => [] as any[]),
    buildAgencyRollups(admin, 30).catch(() => null),
  ])

  const rollup = new Map((agency?.rollups ?? []).map(r => [r.clientId, r]))
  const byClient = new Map<string, DirectoryEntry>()
  for (const c of (clientsRes.data ?? []) as any[]) {
    const r = rollup.get(c.id)
    byClient.set(c.id, {
      id: c.id, name: c.name, code: c.code ?? null, isActive: c.is_active !== false,
      pages: 0, instagram: 0, facebook: 0, followers: null,
      liveCampaigns: 0, activeCampaigns: 0, plan: null, hasPlan: false,
      reach30: r?.reach ?? 0, spend30: r?.spend ?? 0, leads30: r?.leads ?? 0,
      health: r?.health ?? 'green', issues: [],
    })
  }

  let cirqleAccounts = 0
  for (const a of (accountsRes.data ?? []) as any[]) {
    const owner = ownerTypeOf(a)
    if (owner === 'cirqle') { cirqleAccounts += 1; continue }
    if (owner !== 'client' || !a.client_id) continue
    const e = byClient.get(a.client_id)
    if (!e) continue
    e.pages += 1
    if (a.platform === 'instagram') e.instagram += 1
    else e.facebook += 1
    if (a.followers_count != null) e.followers = (e.followers ?? 0) + Number(a.followers_count)
    if (a.status === 'needs_reauth' || a.status === 'error') e.issues.push('An account needs reconnecting')
  }

  for (const p of (projectsRes.data ?? []) as any[]) {
    const e = byClient.get(p.client_id)
    if (!e || p.archived_at) continue
    e.liveCampaigns += 1
    if (p.status === 'active') e.activeCampaigns += 1
  }

  for (const plan of plans) {
    const e = byClient.get(plan.client_id)
    if (!e || e.plan) continue
    e.plan = { id: plan.id, title: plan.title ?? null, progress: planProgress((plan.items ?? []) as PlanItemLike[]) }
    e.hasPlan = true
  }

  // Dedupe issue text; a client with three broken accounts needs one line.
  for (const e of byClient.values()) e.issues = [...new Set(e.issues)]

  return {
    clients: [...byClient.values()],
    unassignedAssets: agency?.totals.unassignedAssets ?? 0,
    cirqleAccounts,
    month,
  }
}

// ── One client ──────────────────────────────────────────────────────────────

export interface HubSocialAccount {
  id: string
  platform: 'facebook_page' | 'instagram'
  name: string
  username: string | null
  external_id: string | null
  profile_picture_url: string | null
  followers_count: number | null
  status: string | null
  publishing_enabled: boolean | null
  insights_enabled: boolean | null
  last_synced_at: string | null
  last_error: string | null
  assigned_at: string | null
  reach30: number
  views30: number
  interactions30: number
  posts30: number
  scheduled: number
  failed: number
}

export interface HubAdAccount {
  id: string
  account_id: string
  name: string | null
  currency: string | null
  assigned_at: string | null
  campaigns: number
}

export interface HubLeadForm { id: string; name: string; external_id: string | null; assigned_at: string | null }

export interface HubPlan {
  id: string
  month: string
  title: string | null
  progress: PlanProgress
}

export interface HubPlanItem {
  id: string
  calendar_id: string
  scheduled_date: string | null
  title: string | null
  content_type: string | null
  platforms: string[] | null
  status: string
  request?: any
  task?: any
}

export interface HubPost {
  id: string
  account_id: string | null
  content_type: string | null
  status: string
  caption: string | null
  scheduled_at: string | null
  cover_url: string | null
}

export interface HubMedia {
  id: string
  account_id: string
  caption: string | null
  media_product_type: string | null
  permalink: string | null
  thumbnail_url: string | null
  media_url: string | null
  posted_at: string | null
  reach: number | null
  views: number | null
  total_interactions: number | null
}

export interface HubLead {
  id: string
  status: 'new' | 'contacted' | 'qualified' | 'won' | 'lost'
  full_name: string | null
  phone: string | null
  email: string | null
  source: string | null
  campaign_name: string | null
  form_name: string | null
  created_at: string
  first_contacted_at: string | null
}

export interface ClientMarketing {
  accounts: HubSocialAccount[]
  adAccounts: HubAdAccount[]
  leadForms: HubLeadForm[]
  plans: HubPlan[]
  currentPlan: HubPlan | null
  /** Plan items from 7 days ago to 21 days ahead, across this client's plans. */
  planItems: HubPlanItem[]
  overduePlanItems: number
  scheduledPosts: HubPost[]
  failedPosts: number
  recentMedia: HubMedia[]
  leads: HubLead[]
  leadCounts30: Record<HubLead['status'], number>
  leads30: number
  staleNewLeads: number
  social30: { reach: number; views: number; interactions: number; posts: number; followers: number | null }
}

export async function loadClientMarketing(
  admin: SupabaseClient,
  clientId: string,
  today: string,
  opts: { social: boolean; leads: boolean; assets: boolean },
): Promise<ClientMarketing> {
  const since30 = addDaysISO(today, -30)
  const month = monthStartISO(today)

  const accountsP = opts.social || opts.assets
    ? admin.from('social_accounts').select(
        'id, client_id, owner_type, platform, name, username, external_id, profile_picture_url, followers_count, ' +
        'status, publishing_enabled, insights_enabled, last_synced_at, last_error, assigned_at',
      ).eq('client_id', clientId).neq('status', 'disconnected').order('platform')
        .then(r => (r.error
          ? admin.from('social_accounts').select(
              'id, client_id, owner_type, platform, name, username, external_id, profile_picture_url, followers_count, ' +
              'status, publishing_enabled, insights_enabled, last_synced_at, last_error',
            ).eq('client_id', clientId).neq('status', 'disconnected')
          : r))
        .then(r => ((r.data ?? []) as any[]).filter(a => ownerTypeOf(a) === 'client'), () => [] as any[])
    : Promise.resolve([] as any[])

  const adAccountsP = opts.assets || opts.social
    ? admin.from('ad_accounts').select('id, account_id, name, currency, owner_type, client_id, assigned_at')
        .eq('client_id', clientId)
        .then(r => (r.error ? admin.from('ad_accounts').select('id, account_id, name, currency, client_id').eq('client_id', clientId) : r))
        .then(r => ((r.data ?? []) as any[]).filter(a => ownerTypeOf(a) === 'client'), () => [] as any[])
    : Promise.resolve([] as any[])

  const leadFormsP = opts.assets || opts.leads
    ? admin.from('lead_forms').select('id, name, external_id, owner_type, client_id, assigned_at').eq('client_id', clientId)
        .then(r => ((r.data ?? []) as any[]).filter(a => ownerTypeOf(a) === 'client'), () => [] as any[])
    : Promise.resolve([] as any[])

  const plansP = opts.social
    ? loadPlans(admin, { clientId }, 'id, calendar_id, scheduled_date, title, content_type, platforms').catch(() => [] as any[])
    : Promise.resolve([] as any[])

  const leadsP = opts.leads
    ? admin.from('leads').select('id, status, full_name, phone, email, source, campaign_name, form_name, created_at, first_contacted_at, owner_type')
        .eq('client_id', clientId).order('created_at', { ascending: false }).limit(200)
        .then(r => ((r.data ?? []) as any[]).filter(l => ownerTypeOf(l) === 'client'), () => [] as any[])
    : Promise.resolve([] as any[])

  const [accountRows, adAccountRows, leadFormRows, planRows, leadRows] = await Promise.all([accountsP, adAccountsP, leadFormsP, plansP, leadsP])
  const accountIds = accountRows.map(a => a.id as string)

  // Per-account insight rollups, posts and media — only for this client's accounts.
  const [insights, posts, media, campaignsByAccount] = await Promise.all([
    opts.social && accountIds.length
      ? admin.from('social_account_insights_daily').select('account_id, reach, views, total_interactions')
          .in('account_id', accountIds).gte('metric_date', since30).limit(5000)
          .then(r => (r.data ?? []) as any[], () => [] as any[])
      : Promise.resolve([] as any[]),
    opts.social
      ? admin.from('social_posts').select('id, account_id, content_type, status, caption, scheduled_at, cover_url')
          .eq('client_id', clientId).in('status', ['scheduled', 'failed', 'pending_approval', 'approved'])
          .is('deleted_at', null).order('scheduled_at', { ascending: true }).limit(100)
          .then(r => (r.data ?? []) as any[], () => [] as any[])
      : Promise.resolve([] as any[]),
    opts.social && accountIds.length
      ? admin.from('social_media_items').select('id, account_id, caption, media_product_type, permalink, thumbnail_url, media_url, posted_at, reach, views, total_interactions, is_story')
          .in('account_id', accountIds).gte('posted_at', `${since30}T00:00:00Z`)
          .order('posted_at', { ascending: false }).limit(60)
          .then(r => ((r.data ?? []) as any[]).filter(m => !m.is_story), () => [] as any[])
      : Promise.resolve([] as any[]),
    adAccountRows.length
      ? admin.from('ad_projects').select('ad_account_id').in('ad_account_id', adAccountRows.map(a => a.id)).is('deleted_at', null).is('archived_at', null)
          .then(r => {
            const m = new Map<string, number>()
            for (const p of (r.data ?? []) as any[]) m.set(p.ad_account_id, (m.get(p.ad_account_id) ?? 0) + 1)
            return m
          }, () => new Map<string, number>())
      : Promise.resolve(new Map<string, number>()),
  ])

  const roll = new Map<string, { reach: number; views: number; interactions: number }>()
  for (const r of insights) {
    const cur = roll.get(r.account_id) ?? { reach: 0, views: 0, interactions: 0 }
    cur.reach += Number(r.reach ?? 0)
    cur.views += Number(r.views ?? 0)
    cur.interactions += Number(r.total_interactions ?? 0)
    roll.set(r.account_id, cur)
  }
  const postsByAccount = new Map<string, number>()
  for (const m of media) postsByAccount.set(m.account_id, (postsByAccount.get(m.account_id) ?? 0) + 1)
  const scheduledBy = new Map<string, number>()
  const failedBy = new Map<string, number>()
  for (const p of posts) {
    if (!p.account_id) continue
    if (p.status === 'scheduled') scheduledBy.set(p.account_id, (scheduledBy.get(p.account_id) ?? 0) + 1)
    if (p.status === 'failed') failedBy.set(p.account_id, (failedBy.get(p.account_id) ?? 0) + 1)
  }

  const accounts: HubSocialAccount[] = accountRows.map(a => ({
    id: a.id, platform: a.platform, name: a.name, username: a.username ?? null, external_id: a.external_id ?? null,
    profile_picture_url: a.profile_picture_url ?? null, followers_count: a.followers_count ?? null,
    status: a.status ?? null, publishing_enabled: a.publishing_enabled ?? null, insights_enabled: a.insights_enabled ?? null,
    last_synced_at: a.last_synced_at ?? null, last_error: a.last_error ?? null, assigned_at: a.assigned_at ?? null,
    reach30: roll.get(a.id)?.reach ?? 0, views30: roll.get(a.id)?.views ?? 0, interactions30: roll.get(a.id)?.interactions ?? 0,
    posts30: postsByAccount.get(a.id) ?? 0, scheduled: scheduledBy.get(a.id) ?? 0, failed: failedBy.get(a.id) ?? 0,
  }))
  // Instagram first (it is where the content goes), then by name.
  accounts.sort((x, y) => (x.platform === y.platform ? x.name.localeCompare(y.name) : x.platform === 'instagram' ? -1 : 1))

  // Plans: newest month first; items flattened for the upcoming list.
  const plans: HubPlan[] = planRows.map(p => ({
    id: p.id, month: String(p.month).slice(0, 10), title: p.title ?? null,
    progress: planProgress((p.items ?? []) as PlanItemLike[]),
  }))
  const currentPlan = plans.find(p => p.month === month) ?? null
  const windowFrom = addDaysISO(today, -7)
  const windowTo = addDaysISO(today, 21)
  const planItems: HubPlanItem[] = []
  let overduePlanItems = 0
  for (const p of planRows) {
    for (const it of (p.items ?? []) as any[]) {
      const date = it.scheduled_date ? String(it.scheduled_date).slice(0, 10) : null
      const item: HubPlanItem = {
        id: it.id, calendar_id: p.id, scheduled_date: date, title: it.title ?? null,
        content_type: it.content_type ?? null, platforms: it.platforms ?? null, status: it.status,
        request: one(it.request), task: one(it.task),
      }
      if (date && date >= windowFrom && date <= windowTo) planItems.push(item)
      if (p.id === currentPlan?.id && date && date < today) {
        const prog = planProgress([item as PlanItemLike]).counts
        if (!prog.done && !prog.delivered && !prog.cancelled) overduePlanItems += 1
      }
    }
  }
  planItems.sort((a, b) => (a.scheduled_date ?? '').localeCompare(b.scheduled_date ?? ''))

  const leads: HubLead[] = leadRows.map(l => ({
    id: l.id, status: l.status, full_name: l.full_name ?? null, phone: l.phone ?? null, email: l.email ?? null,
    source: l.source ?? null, campaign_name: l.campaign_name ?? null, form_name: l.form_name ?? null,
    created_at: l.created_at, first_contacted_at: l.first_contacted_at ?? null,
  }))
  const leadCounts30: Record<HubLead['status'], number> = { new: 0, contacted: 0, qualified: 0, won: 0, lost: 0 }
  let leads30 = 0
  let staleNewLeads = 0
  const dayAgo = Date.now() - 86_400_000
  for (const l of leads) {
    if (l.created_at.slice(0, 10) >= since30) {
      leads30 += 1
      if (l.status in leadCounts30) leadCounts30[l.status] += 1
    }
    if (l.status === 'new' && Date.parse(l.created_at) < dayAgo) staleNewLeads += 1
  }

  const followers = accounts.reduce<number | null>((s, a) => (a.followers_count == null ? s : (s ?? 0) + a.followers_count), null)

  return {
    accounts,
    adAccounts: adAccountRows.map(a => ({
      id: a.id, account_id: String(a.account_id), name: a.name ?? null, currency: a.currency ?? null,
      assigned_at: a.assigned_at ?? null, campaigns: campaignsByAccount.get(a.id) ?? 0,
    })),
    leadForms: leadFormRows.map(f => ({ id: f.id, name: f.name ?? 'Lead form', external_id: f.external_id ?? null, assigned_at: f.assigned_at ?? null })),
    plans,
    currentPlan,
    planItems,
    overduePlanItems,
    scheduledPosts: posts.filter(p => p.status !== 'failed'),
    failedPosts: posts.filter(p => p.status === 'failed').length,
    recentMedia: media,
    leads,
    leadCounts30,
    leads30,
    staleNewLeads,
    social30: {
      reach: accounts.reduce((s, a) => s + a.reach30, 0),
      views: accounts.reduce((s, a) => s + a.views30, 0),
      interactions: accounts.reduce((s, a) => s + a.interactions30, 0),
      posts: media.length,
      followers,
    },
  }
}
