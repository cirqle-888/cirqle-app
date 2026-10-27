/**
 * Ad Funds page — server-side data (statement, top-up suggestions, to-dos).
 *
 * All the arithmetic lives in lib/advertising/funds-core.ts; this file only
 * reads rows and shapes them. Defensive like the other advertising loaders:
 * before migration 20261027120000 is applied, `migrated` is false and the
 * page shows a setup notice instead of failing.
 */

import { createAdminClient } from '@/lib/supabase/server'
import { loadCampaignOwners } from '@/lib/advertising/meta-billing'
import {
  one, asRows, num,
  type AdAccountRow, type AdProjectLite, type CampaignSpendRow, type DailyMetricRow, type ExpenseLineRow,
  type FundingEventRow, type TopUpEntryRow,
} from '@/lib/advertising/funds-rows'
import { todayISO, addDaysISO } from '@/lib/utils/local-date'
import {
  buildStatement, suggestTopUp, failedInitiations, unconfirmedTopUps, withGst,
  type StatementClient, type StatementSpend, type StatementBilled, type TopUpSuggestion,
  type FundingEventLite,
} from '@/lib/advertising/funds-core'

export interface FundsAccount {
  id: string
  name: string
  accountId: string
  currency: string | null
  availableBalance: number | null
  fundingDisplay: string | null
  syncedAt: string | null
  syncError: string | null
}

export interface FundsCampaign {
  id: string
  name: string
  clientId: string | null
  adAccountId: string | null
  status: string
}

export interface FundsSuggestion extends TopUpSuggestion {
  clientId: string
  adAccountId: string | null
  activeCampaigns: number
}

export interface FundsTodo {
  key: string
  kind: 'unrecorded' | 'failed' | 'unconfirmed' | 'unmapped' | 'short'
  title: string
  detail: string
  amount: number | null
  date: string | null
  adAccountId: string | null
  eventId?: string
  entryId?: string
  clientId?: string | null
  suggestedClientId?: string | null
}

export interface FundsData {
  migrated: boolean
  accounts: FundsAccount[]
  clients: { id: string; name: string; code: string | null }[]
  banks: { id: string; name: string; isDefault: boolean }[]
  campaigns: FundsCampaign[]
  /** Unlinked client-tagged outflows a Meta payment could be linked to. */
  linkableEntries: { id: string; date: string; description: string; amount: number }[]
  suggestions: FundsSuggestion[]
  todos: FundsTodo[]
  statement: StatementClient[]
  currentPeriod: string
}

const BURN_DAYS = 3
const LEGACY_TOPUP = /meta|ads?\s*spen|online spend|fund/i

export async function loadFundsData(): Promise<FundsData> {
  const admin = createAdminClient()
  const today = todayISO()
  const currentPeriod = today.slice(0, 7)
  const since = addDaysISO(`${currentPeriod}-01`, -400)

  const empty: FundsData = {
    migrated: false, accounts: [], clients: [], banks: [], campaigns: [], linkableEntries: [],
    suggestions: [], todos: [], statement: [], currentPeriod,
  }

  // ── Accounts (the billing_* columns double as the migration probe) ───────
  const { data: accRows, error: accErr } = await admin.from('ad_accounts')
    .select('id, name, account_id, currency, is_active, billing_available_balance, billing_funding_display, billing_synced_at, billing_sync_error')
    .eq('is_active', true).order('name')
  if (accErr) return empty
  const accounts: FundsAccount[] = asRows<AdAccountRow>(accRows).map(a => ({
    id: a.id, name: a.name, accountId: a.account_id, currency: a.currency,
    availableBalance: a.billing_available_balance != null ? num(a.billing_available_balance) : null,
    fundingDisplay: a.billing_funding_display ?? null, syncedAt: a.billing_synced_at ?? null, syncError: a.billing_sync_error ?? null,
  }))
  const accountIds = accounts.map(a => a.id)

  const [clientsRes, banksRes, projectsRes, spendRes, eventsRes, topupsRes, billedRes, owners] = await Promise.all([
    admin.from('clients').select('id, name, code').order('name'),
    admin.from('bank_accounts').select('id, name, is_default, is_active').order('name'),
    admin.from('ad_projects').select('id, campaign_name, client_id, ad_account_id, status, scope, provider_metadata')
      .is('deleted_at', null),
    accountIds.length
      ? admin.from('ad_campaign_daily_spend').select('ad_account_id, external_campaign_id, campaign_name, spend_date, spend')
          .in('ad_account_id', accountIds).gte('spend_date', since).limit(20000)
      : Promise.resolve({ data: [] as unknown[] }),
    accountIds.length
      ? admin.from('ad_funding_events')
          .select('id, ad_account_id, status, amount, event_time, cashbook_entry_id, suggested_client_id, dismissed_at')
          .in('ad_account_id', accountIds).gte('event_time', `${addDaysISO(today, -120)}T00:00:00Z`)
          .order('event_time', { ascending: false })
      : Promise.resolve({ data: [] as unknown[] }),
    admin.from('cashbook_entries').select('id, ad_account_id, client_id, amount, entry_date, description')
      .not('ad_account_id', 'is', null).eq('type', 'outflow').is('deleted_at', null)
      .gte('entry_date', addDaysISO(today, -120)),
    admin.from('invoice_expense_items')
      .select(`id, kind, amount_inr, description, ad_project_id, ad_period,
               invoice:invoices!inner(id, invoice_number, status, client_id, billing_period_start, issue_date),
               entry:cashbook_entries(ad_account_id, category:cashbook_categories(account_code))`)
      .gte('created_at', `${since}T00:00:00Z`).limit(5000),
    loadCampaignOwners(admin, accountIds),
  ])

  const clients = asRows<{ id: string; name: string; code: string | null }>(clientsRes.data).map(c => ({ id: c.id, name: c.name, code: c.code ?? null }))
  const banks = asRows<{ id: string; name: string; is_default: boolean | null; is_active: boolean | null }>(banksRes.data)
    .filter(b => b.is_active !== false)
    .map(b => ({ id: b.id, name: b.name, isDefault: !!b.is_default }))
  const projects = asRows<AdProjectLite>(projectsRes.data)
  const campaigns: FundsCampaign[] = projects.map(p => ({
    id: p.id, name: p.campaign_name, clientId: p.client_id ?? null, adAccountId: p.ad_account_id ?? null, status: p.status,
  }))

  // ── Spend rows (account sync first; manual/legacy campaigns from metrics) ─
  const spend: StatementSpend[] = []
  const coveredProjects = new Set<string>()
  for (const s of asRows<Required<Pick<CampaignSpendRow, 'ad_account_id'>> & CampaignSpendRow>(spendRes.data)) {
    const own = owners.get(`${s.ad_account_id}:${s.external_campaign_id}`)
    if (own?.projectId) coveredProjects.add(own.projectId)
    spend.push({
      clientId: own?.clientId ?? null, projectId: own?.projectId ?? null,
      campaignKey: `${s.ad_account_id}:${s.external_campaign_id}`, campaignName: s.campaign_name || s.external_campaign_id,
      date: s.spend_date, spendExGst: num(s.spend),
    })
  }
  // Every live project whose campaign the account sync already reports is
  // covered — not only the registry's owner — so a second project for the same
  // campaign never adds its spend again.
  const syncedKeys = new Set(asRows<CampaignSpendRow>(spendRes.data).map(s => `${s.ad_account_id}:${s.external_campaign_id}`))
  for (const p of projects) {
    const cid = p.provider_metadata?.campaign_id
    if (p.ad_account_id && cid != null && syncedKeys.has(`${p.ad_account_id}:${cid}`)) coveredProjects.add(p.id)
  }
  // Manual / legacy metrics only fill months the account sync has nothing for
  // that client — once a client's campaigns are mapped, the synced spend wins.
  const syncedClientMonths = new Set(spend.filter(s => s.clientId).map(s => `${s.clientId}:${s.date.slice(0, 7)}`))
  const metricProjects = projects.filter(p => p.client_id && p.scope !== 'company' && !coveredProjects.has(p.id))
  if (metricProjects.length) {
    const { data: metrics } = await admin.from('ad_daily_metrics')
      .select('project_id, metric_date, spend, exchange_rate_ad_to_base')
      .in('project_id', metricProjects.map(p => p.id)).gte('metric_date', since)
    const byId = new Map(metricProjects.map(p => [p.id, p]))
    for (const m of asRows<DailyMetricRow>(metrics)) {
      const p = byId.get(m.project_id ?? '')
      if (!p || syncedClientMonths.has(`${p.client_id}:${m.metric_date.slice(0, 7)}`)) continue
      spend.push({
        clientId: p.client_id, projectId: p.id, campaignKey: `project:${p.id}`, campaignName: p.campaign_name,
        date: m.metric_date, spendExGst: num(m.spend) * (num(m.exchange_rate_ad_to_base) || 1),
      })
    }
  }
  // Company (internal) campaigns are never billed — keep them off the statement.
  const companyProjects = new Set(projects.filter(p => p.scope === 'company').map(p => p.id))
  const billableSpend = spend.filter(s => !s.projectId || !companyProjects.has(s.projectId))

  // ── What was invoiced ────────────────────────────────────────────────────
  const billed: StatementBilled[] = []
  for (const r of asRows<ExpenseLineRow>(billedRes.data)) {
    const inv = one(r.invoice)
    if (!inv?.client_id || inv.status === 'cancelled') continue
    const entry = one(r.entry)
    const cat = entry ? one(entry.category) : null
    const isAd = r.kind === 'ad_spend'
    const isLegacyTopUp = !isAd && (entry?.ad_account_id || cat?.account_code === 'cogs.ad_spend' || LEGACY_TOPUP.test(r.description || ''))
    if (!isAd && !isLegacyTopUp) continue
    const period = isAd && r.ad_period ? r.ad_period
      : (inv.billing_period_start || addDaysISO(String(inv.issue_date).slice(0, 10), -1) || '').slice(0, 7)
    if (!period) continue
    billed.push({
      clientId: inv.client_id, period, amountInr: num(r.amount_inr),
      source: isAd ? 'ad_spend' : 'topup', invoiceNumber: inv.invoice_number ?? null,
      invoiceStatus: inv.status ?? null, projectId: r.ad_project_id ?? null,
    })
  }
  // Legacy lines that rebilled a top-up only count from the month the client's
  // spend data starts: an older top-up line has no spend to set against (it
  // predates the sync window), so it would show as "invoiced extra" forever.
  const firstSpendPeriod = new Map<string, string>()
  for (const s of billableSpend) {
    if (!s.clientId || s.spendExGst <= 0) continue
    const p = s.date.slice(0, 7)
    if (!firstSpendPeriod.has(s.clientId) || p < firstSpendPeriod.get(s.clientId)!) firstSpendPeriod.set(s.clientId, p)
  }
  const comparable = billed.filter(b => {
    if (b.source === 'ad_spend') return true
    const first = firstSpendPeriod.get(b.clientId)
    return !!first && b.period >= first
  })
  const statement = buildStatement(billableSpend, comparable, currentPeriod)

  // ── Wallet runway → top-up suggestions ───────────────────────────────────
  const clientIds = [...new Set(campaigns.filter(c => c.clientId).map(c => c.clientId as string))]
  const { data: credits } = clientIds.length
    ? await admin.from('ad_wallet_ledger')
        .select('client_id, amount_inr, created_at, entry:cashbook_entries(entry_date)')
        .eq('direction', 'credit').is('deleted_at', null).in('client_id', clientIds)
    : { data: [] as unknown[] }
  const wallets = new Map<string, { creditedInr: number; firstCreditDate: string }>()
  type CreditRow = { client_id: string; amount_inr: number | string | null; created_at: string; entry: { entry_date: string } | { entry_date: string }[] | null }
  for (const c of asRows<CreditRow>(credits)) {
    const d = String(one(c.entry)?.entry_date ?? c.created_at).slice(0, 10)
    const w = wallets.get(c.client_id) ?? { creditedInr: 0, firstCreditDate: d }
    w.creditedInr += num(c.amount_inr)
    if (d < w.firstCreditDate) w.firstCreditDate = d
    wallets.set(c.client_id, w)
  }
  const burnFrom = addDaysISO(today, -BURN_DAYS)
  const suggestions: FundsSuggestion[] = []
  for (const clientId of clientIds) {
    const mine = billableSpend.filter(s => s.clientId === clientId)
    const active = campaigns.filter(c => c.clientId === clientId && c.status === 'active')
    const recent = withGst(mine.filter(s => s.date > burnFrom).reduce((t, s) => t + s.spendExGst, 0))
    const w = wallets.get(clientId)
    // A client billed the old way (top-ups rebilled, no wallet) only shows up
    // once a campaign is actually spending.
    if (!w && (!active.length || recent <= 0)) continue
    // The wallet balance counts spend from the first wallet top-up onwards,
    // so history from before the wallet was used never shows as owed.
    const spentInclGstInr = w ? withGst(mine.filter(s => s.date >= w.firstCreditDate).reduce((t, s) => t + s.spendExGst, 0)) : 0
    const s = suggestTopUp({
      creditedInr: w?.creditedInr ?? 0, spentInclGstInr,
      recentSpendInclGstInr: recent, burnDays: BURN_DAYS, activeCampaigns: active.length,
    })
    suggestions.push({ ...s, clientId, adAccountId: active[0]?.adAccountId ?? null, activeCampaigns: active.length })
  }
  suggestions.sort((a, b) => rank(a) - rank(b))

  // ── To-dos ───────────────────────────────────────────────────────────────
  const eventRows = asRows<FundingEventRow>(eventsRes.data)
  const events: FundingEventLite[] = eventRows.map(e => ({
    id: e.id, adAccountId: e.ad_account_id, status: e.status, amount: e.amount != null ? num(e.amount) : null,
    eventTime: e.event_time, cashbookEntryId: e.cashbook_entry_id, dismissedAt: e.dismissed_at,
  }))
  const suggestedBy = new Map(eventRows.map(e => [e.id, e.suggested_client_id]))
  const accName = new Map(accounts.map(a => [a.id, a.name]))
  const todos: FundsTodo[] = []
  const now = new Date()

  for (const e of events) {
    if (e.status !== 'successful' || e.cashbookEntryId || e.dismissedAt) continue
    todos.push({
      key: `unrecorded:${e.id}`, kind: 'unrecorded', eventId: e.id, adAccountId: e.adAccountId,
      amount: e.amount, date: e.eventTime.slice(0, 10), suggestedClientId: suggestedBy.get(e.id) ?? null,
      title: `Meta payment of ${fmt(e.amount)} is not in the Cashbook`,
      detail: `Added to ${accName.get(e.adAccountId) ?? 'an ad account'} on ${day(e.eventTime)}. Record it for the client it was for.`,
    })
  }
  for (const e of failedInitiations(events, now)) {
    todos.push({
      key: `failed:${e.id}`, kind: 'failed', eventId: e.id, adAccountId: e.adAccountId, amount: e.amount, date: e.eventTime.slice(0, 10),
      title: `Meta payment${e.amount ? ` of ${fmt(e.amount)}` : ''} did not go through`,
      detail: `Started on ${day(e.eventTime)} on ${accName.get(e.adAccountId) ?? 'an ad account'} but never succeeded. If your bank was debited, ask the bank for a reversal.`,
    })
  }
  const syncedAccounts = new Set(accounts.filter(a => a.syncedAt).map(a => a.id))
  const topups = asRows<TopUpEntryRow & { ad_account_id: string }>(topupsRes.data)
  // Only entries dated after the account's billing history starts can be judged.
  const firstEventDay = new Map<string, string>()
  for (const e of events) {
    const d = e.eventTime.slice(0, 10)
    if (!firstEventDay.has(e.adAccountId) || d < firstEventDay.get(e.adAccountId)!) firstEventDay.set(e.adAccountId, d)
  }
  const judged = topups.filter(t => firstEventDay.has(t.ad_account_id) && t.entry_date >= firstEventDay.get(t.ad_account_id)!)
  for (const t of unconfirmedTopUps(
    judged.map(t => ({ id: t.id, adAccountId: t.ad_account_id, amount: num(t.amount), entryDate: t.entry_date })),
    events, syncedAccounts, now,
  )) {
    todos.push({
      key: `unconfirmed:${t.id}`, kind: 'unconfirmed', entryId: t.id, adAccountId: t.adAccountId, amount: t.amount, date: t.entryDate,
      title: `Top-up of ${fmt(t.amount)} recorded, but Meta has no matching payment`,
      detail: `Cashbook entry dated ${t.entryDate}. If the payment failed, delete the entry; if the amount differs, correct it.`,
    })
  }
  const recentUnmapped = new Map<string, { name: string; ex: number; acc: string | null }>()
  for (const s of spend) {
    if (s.clientId || s.date < addDaysISO(today, -60) || s.spendExGst <= 0) continue
    const cur = recentUnmapped.get(s.campaignKey) ?? { name: s.campaignName, ex: 0, acc: s.campaignKey.split(':')[0] ?? null }
    cur.ex += s.spendExGst
    recentUnmapped.set(s.campaignKey, cur)
  }
  for (const [k, v] of recentUnmapped) {
    todos.push({
      key: `unmapped:${k}`, kind: 'unmapped', adAccountId: v.acc, amount: withGst(v.ex), date: null,
      title: `Campaign "${v.name}" is not linked to a client`,
      detail: `${fmt(withGst(v.ex))} spent (incl. GST) in the last 60 days that cannot be invoiced. Map it in Advertising › Ad Accounts.`,
    })
  }
  const lastClosed = addDaysISO(`${currentPeriod}-01`, -1).slice(0, 7)
  const threeBack = addDaysISO(`${currentPeriod}-01`, -85).slice(0, 7)
  for (const c of statement) {
    if (!c.clientId) continue
    for (const m of c.months) {
      if ((m.status === 'short' || m.status === 'not_invoiced') && m.period >= threeBack && m.period <= lastClosed) {
        todos.push({
          key: `short:${c.clientId}:${m.period}`, kind: 'short', clientId: c.clientId, adAccountId: null,
          amount: m.differenceInr, date: `${m.period}-01`,
          title: `${clients.find(x => x.id === c.clientId)?.name ?? 'Client'}: ${fmt(m.differenceInr)} of ${monthName(m.period)} ad spend not invoiced`,
          detail: `Spent ${fmt(m.spendInclGst)} incl. GST, invoiced ${fmt(m.billedInr)}.`,
        })
      }
    }
  }

  // ── Plain outflows a Meta payment could be linked to ─────────────────────
  const { data: linkable } = await admin.from('cashbook_entries')
    .select('id, entry_date, description, amount')
    .eq('type', 'outflow').is('deleted_at', null).is('ad_account_id', null)
    .gte('entry_date', addDaysISO(today, -120)).order('entry_date', { ascending: false }).limit(200)

  return {
    migrated: true, accounts, clients, banks, campaigns,
    linkableEntries: asRows<TopUpEntryRow>(linkable).map(e => ({ id: e.id, date: e.entry_date, description: e.description || '', amount: num(e.amount) })),
    suggestions, todos, statement, currentPeriod,
  }
}

const rank = (s: TopUpSuggestion) => ({ empty: 0, low: 1, ok: 2, idle: 3 }[s.level])
const fmt = (v: number | null) => v == null ? 'an unknown amount' : `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
const monthName = (p: string) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })

/** One client's slice of the funds data — for the client workspace / Client Hub. */
export interface ClientFundsData {
  migrated: boolean
  clientId: string
  accounts: FundsAccount[]
  banks: FundsData['banks']
  campaigns: FundsCampaign[]
  clients: FundsData['clients']
  suggestion: FundsSuggestion | null
  todos: FundsTodo[]
  statement: StatementClient | null
  currentPeriod: string
}

export function sliceFundsForClient(d: FundsData, clientId: string): ClientFundsData {
  return {
    migrated: d.migrated,
    clientId,
    accounts: d.accounts,
    banks: d.banks,
    campaigns: d.campaigns.filter(c => c.clientId === clientId),
    clients: d.clients.filter(c => c.id === clientId),
    suggestion: d.suggestions.find(s => s.clientId === clientId) ?? null,
    todos: d.todos.filter(t => t.clientId === clientId || (t.kind === 'unrecorded' && t.suggestedClientId === clientId)),
    statement: d.statement.find(s => s.clientId === clientId) ?? null,
    currentPeriod: d.currentPeriod,
  }
}
