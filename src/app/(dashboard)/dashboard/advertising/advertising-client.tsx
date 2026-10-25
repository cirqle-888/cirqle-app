'use client'

/**
 * Advertising dashboard — client-first financial view.
 *
 * Hierarchy: Client cards (wallet: credited / allocated / remaining / Meta
 * spend / GST diff) → campaign cards (allocated, billing, KPIs). A view toggle
 * keeps the old flat "All Campaigns" grid available. Wallet money moves only
 * via ledger transactions (ad_wallet_ledger) — balances are always derived.
 *
 * Client-first (plan Phase 3): a period selector (kept in the URL) drives
 * every spend/result number; results are grouped by objective instead of a
 * single cross-campaign ROAS/Leads total; a "Needs attention" queue sits on
 * top; each card leads with its objective's result and says how fresh its
 * data is.
 */

import { useMemo, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { usePrivacy } from '@/contexts/privacy-context'
import {
  Megaphone, Plus, TrendingUp, Target, Wallet, ArrowRight, Inbox, Play,
  Loader2, Link2, BarChart3, Zap, AlertTriangle,
  Clock, ChevronRight, ChevronDown, History, Trash2, ArrowDownLeft, ArrowUpRight, ArrowLeft,
  Search, RefreshCw, BellOff, CheckCircle2, Info,
} from 'lucide-react'
import {
  AD_STATUS_CHIP, STATUS_LABEL, PLATFORM_LABEL, CAMPAIGN_TYPE_LABEL, STATUSES, type AdProjectRow,
} from '@/lib/advertising/types'
import { remainingBudget } from '@/lib/advertising/metrics'
import { aggregateMetrics } from '@/lib/advertising/reporting'
import type { BenchmarkResult } from '@/lib/advertising/ai/benchmarks'
import type { HealthScoreResult } from '@/lib/advertising/ai/scoring'
import { assessCampaignHealth } from '@/lib/reporting/campaign-health'
import { resultDefinitionFor, resultCount, costPerSelectedResult } from '@/lib/reporting/result-type'
import { todayISO, addDaysISO } from '@/lib/utils/local-date'
import { PERIODS, DEFAULT_PERIOD, isPeriodKey, periodRange, rowsInPeriod, type PeriodKey } from '@/lib/advertising/period'
import { objectiveStats, type StatTile } from '@/lib/advertising/objective-stats'
import { syncFreshness } from '@/lib/advertising/freshness'
import {
  buildAttentionItems, withoutSnoozed,
  type AttentionItem, type AttentionConnection, type AttentionReport,
} from '@/lib/advertising/attention'
import type { ResultDefinition } from '@/lib/reporting/result-type'
import { computeServiceCharge, spendWithGst } from '@/lib/advertising/budget'
import { startAdvertisingRequest, addClientFund, addCompanyFund, removeWalletTransaction, snoozeAttention } from './actions'
import { DiscussButton } from '@/components/chat/discuss-button'

interface PendingRequest {
  id: string
  ref_no: number | null
  title: string
  created_at: string
  ad_meta: { platform?: string | null; campaign_type?: string | null; ad_budget?: number | null } | null
  client?: { id: string; name: string } | null
}

export interface LedgerRowView {
  id: string
  client_id: string
  direction: 'credit' | 'debit'
  kind: string
  ad_project_id: string | null
  cashbook_entry_id: string | null
  amount: number
  amount_inr: number
  notes: string | null
  created_at: string
  creator?: { id: string; name: string; cqid?: string | null } | null
  entry?: { id: string; entry_date: string; description: string; reference: string | null } | null
  project?: { id: string; campaign_name: string } | null
}

export interface FundCandidate {
  id: string
  entry_date: string
  description: string
  reference: string | null
  amount: number
  amount_inr: number
  currency: string
  uncredited: number
}

type ProjectRow = AdProjectRow & { client?: { id: string; name: string; code: string } | null }

/** Server-loaded inputs for the Needs-attention queue (page.tsx). */
export interface AttentionData {
  connections: AttentionConnection[]
  failedReports: AttentionReport[]
  failedEmails: { reportId: string; recipient: string; at: string }[]
  /** created_by employee id → CQID (names never reach the browser). */
  ownerCqids: Record<string, string>
  /** alert key → snoozed until (ISO). */
  snoozes: Record<string, string>
  /** false until migration 20261025180000_ad_attention_snoozes is applied. */
  snoozeSupported: boolean
}

interface Props {
  migrated: boolean
  initialProjects: ProjectRow[]
  metricsByProject: Record<string, any[]>
  /** Report benchmark tiers per project (missing = none available). */
  benchmarksByProject?: Record<string, BenchmarkResult>
  attention?: AttentionData
  pendingRequests: PendingRequest[]
  clients: { id: string; name: string; code: string }[]
  walletSupported: boolean
  ledger: LedgerRowView[]
  fundCandidates: FundCandidate[]
  perms: { create: boolean; edit: boolean; manageBudget: boolean; viewFinancials: boolean; viewBilling: boolean }
}

const inr = (v: number | null | undefined, dp = 0) =>
  v == null ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: dp })}`
const round2 = (v: number) => Math.round(v * 100) / 100

/** How fresh a card's data is (shared wording: lib/advertising/freshness.ts). */
const freshness = (p: ProjectRow) => syncFreshness(p)

function daysRemaining(endDate: string | null): number | null {
  if (!endDate) return null
  const end = new Date(endDate).getTime()
  if (Number.isNaN(end)) return null
  return Math.ceil((end - Date.now()) / 86_400_000)
}

/** Health under the shared rules: a letter grade, or "Not graded" (with the
 *  reason on hover) when performance cannot be judged yet. */
export function HealthBadge({ health }: { health: HealthScoreResult }) {
  const ungraded = health.insufficientData === true
  const { bg, text, dot } =
    ungraded ? { bg: 'bg-muted/60', text: 'text-muted-foreground', dot: 'bg-muted-foreground/40' }
    : health.grade === 'A' || health.grade === 'B' ? { bg: 'bg-emerald-500/10', text: 'text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500' }
    : health.grade === 'C' ? { bg: 'bg-green-500/10', text: 'text-green-700 dark:text-green-400', dot: 'bg-green-500' }
    : health.grade === 'D' ? { bg: 'bg-amber-500/10', text: 'text-amber-700 dark:text-amber-400', dot: 'bg-amber-500' }
    : { bg: 'bg-red-500/10', text: 'text-red-700 dark:text-red-400', dot: 'bg-red-500' }
  const why = health.explanations.find(e => !e.startsWith('Not enough data')) ?? ''

  return (
    <span title={why} className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${bg} ${text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {ungraded ? 'Not graded' : `Grade ${health.grade} · ${health.score}`}
    </span>
  )
}

export function KpiCard({
  icon: Icon, label, value, sub, accent = false,
}: {
  icon: typeof Wallet
  label: string
  value: string | number
  sub?: string
  accent?: boolean
}) {
  return (
    <div className={`rounded-xl border p-4 ${accent ? 'border-pink-500/30 bg-pink-500/[0.04]' : 'border-border bg-card'}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</span>
        <Icon className={`h-4 w-4 ${accent ? 'text-pink-500' : 'text-muted-foreground/60'}`} />
      </div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}

function BudgetBar({ spent, total }: { spent: number; total: number }) {
  if (!total) return null
  const pct = Math.min(100, (spent / total) * 100)
  const color = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <div className="mt-2">
      <div className="flex justify-between text-[10px] text-muted-foreground mb-0.5">
        <span>{inr(spent)} spent</span>
        <span>{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-secondary/50 px-2 py-1.5 text-center min-w-0">
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground font-medium">{label}</div>
      <div className="text-xs font-semibold tabular-nums mt-0.5 truncate">{value}</div>
    </div>
  )
}

// ─── Card data assembly ───────────────────────────────────────────────────────

export interface CardData {
  p: ProjectRow
  /** Lifetime totals (funding, health). */
  agg: ReturnType<typeof aggregateMetrics>
  /** Totals for the selected period (headline numbers). */
  periodAgg: ReturnType<typeof aggregateMetrics>
  definition: ResultDefinition
  /** Objective results in the selected period (null = none / not recorded). */
  periodResults: number | null
  stats: StatTile[]
  health: HealthScoreResult
  remaining: number | null
  days: number | null
  allocated: number
  billing: number
}

interface ClientWallet { credited: number; allocated: number; balance: number }

interface ClientGroup {
  clientId: string
  name: string
  code: string
  cards: CardData[]
  wallet: ClientWallet
  metaSpend: number
}

/** One card per campaign: lifetime + period totals, objective stats, health. */
export function buildCampaignCards(
  initialProjects: ProjectRow[],
  metricsByProject: Record<string, any[]>,
  allocatedByProject: Record<string, number>,
  benchmarksByProject: Record<string, BenchmarkResult>,
  range: ReturnType<typeof periodRange>,
): CardData[] {
  const today = todayISO()
  return initialProjects.map(p => {
    const rows = metricsByProject[p.id] || []
    const agg = aggregateMetrics(rows)
    // Lifetime health under the shared rules (campaign-health.ts) — the same
    // verdict the campaign page and its reports give. No ROAS forecast here:
    // without revenue it is never used, and the list stays cheap.
    const definition = resultDefinitionFor(p.campaign_type, { leads: agg.leads })
    const results = resultCount(definition, agg)
    const firstDate = rows.reduce<string | null>((m, r) => (!m || r.metric_date < m ? r.metric_date : m), null)
    const bm = benchmarksByProject[p.id]
    const health = assessCampaignHealth({
      spend: agg.spend, revenue: agg.revenue, roas: agg.roas, ctr: agg.ctr, cpc: agg.cpc,
      conversionRate: agg.clicks > 0 ? (agg.leads / agg.clicks) * 100 : 0,
      results, costPerResult: costPerSelectedResult(agg.spend, results),
      budget: Number(p.ad_budget_amount || 0),
      campaignStart: p.start_date, campaignEnd: p.end_date,
      periodFrom: p.start_date ?? firstDate ?? today, periodTo: today, today,
      benchmarks: bm?.metrics ?? null, benchmarkSource: bm?.source ?? null,
    })
    const allocated = allocatedByProject[p.id] || 0
    const billing = computeServiceCharge(
      allocated,
      p.service_charge_type, Number(p.service_charge_value || 0),
    )
    const periodAgg = aggregateMetrics(rowsInPeriod(rows, range))
    return {
      p, agg, periodAgg, definition, health,
      periodResults: resultCount(definition, periodAgg),
      stats: objectiveStats(definition, periodAgg),
      remaining: remainingBudget(p.ad_budget_amount, agg.spend),
      days: daysRemaining(p.end_date),
      allocated, billing,
    }
  })
}

/** Σ campaign-allocation debits per project. */
export function allocationsByProject(ledger: LedgerRowView[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of ledger) {
    if (r.direction === 'debit' && r.ad_project_id) {
      out[r.ad_project_id] = round2((out[r.ad_project_id] || 0) + Number(r.amount_inr || 0))
    }
  }
  return out
}

/** Needs-attention items for a set of cards (rules: lib/advertising/attention.ts). */
export function computeAttentionItems(
  attention: AttentionData | undefined,
  cards: CardData[],
  metricsByProject: Record<string, any[]>,
  walletSupported: boolean,
): AttentionItem[] {
  if (!attention) return []
  const today = todayISO()
  const recentDates = [addDaysISO(today, -1), addDaysISO(today, -2)]
  const items = buildAttentionItems({
    today, now: new Date(),
    campaigns: cards.map(c => {
      const rows = metricsByProject[c.p.id] || []
      const recentSpendByDate: Record<string, number> = {}
      for (const r of rows) if (recentDates.includes(r.metric_date)) recentSpendByDate[r.metric_date] = Number(r.spend || 0)
      return {
        id: c.p.id, name: c.p.campaign_name, clientName: c.p.client?.name ?? null,
        owner: c.p.created_by ? attention.ownerCqids[c.p.created_by] ?? null : null,
        status: c.p.status, archived: !!c.p.archived_at,
        syncEnabled: !!c.p.sync_enabled, syncStatus: c.p.sync_status ?? null,
        lastSyncAt: c.p.last_sync_at ?? null, lastSyncError: c.p.last_sync_error ?? null,
        hasAdAccount: !!c.p.ad_account_id, endDate: c.p.end_date,
        recentSpendByDate,
        unspentAllocation: walletSupported && c.allocated > 0 ? round2(c.allocated - spendWithGst(c.agg.spend || 0)) : null,
        allocated: walletSupported ? c.allocated : null,
        spendInclGst: spendWithGst(c.agg.spend || 0),
      }
    }),
    connections: attention.connections,
    failedReports: attention.failedReports,
    failedEmails: attention.failedEmails,
  })
  return withoutSnoozed(items, attention.snoozes, new Date())
}

type ViewMode = 'clients' | 'all'
type BalanceFilter = 'all' | 'positive' | 'low' | 'negative'

export default function AdvertisingClient({
  migrated, initialProjects, metricsByProject, benchmarksByProject = {}, attention, pendingRequests, clients,
  walletSupported, ledger, fundCandidates, perms,
}: Props) {
  // Period lives in the URL (?period=30d) so it survives reloads and links.
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const rawPeriod = searchParams.get('period')
  const period: PeriodKey = isPeriodKey(rawPeriod) ? rawPeriod : DEFAULT_PERIOD
  const range = useMemo(() => periodRange(period, todayISO()), [period])
  function setPeriod(next: PeriodKey) {
    const q = new URLSearchParams(searchParams.toString())
    if (next === DEFAULT_PERIOD) q.delete('period'); else q.set('period', next)
    // Native history: updates useSearchParams without a server round trip
    // (Next.js integrates replaceState with the router).
    window.history.replaceState(null, '', q.size ? `${pathname}?${q}` : pathname)
  }
  const [search, setSearch] = useState('')
  const [view, setView] = useState<ViewMode>('clients')
  const [fClient, setFClient] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [fPlatform, setFPlatform] = useState('')
  const [fMonth, setFMonth] = useState('')
  const [fBalance, setFBalance] = useState<BalanceFilter>('all')
  const [fArchived, setFArchived] = useState(false)

  const allocatedByProject = useMemo(() => allocationsByProject(ledger), [ledger])

  // Wallet summary per client (credits − debits).
  const walletByClient = useMemo(() => {
    const out: Record<string, ClientWallet> = {}
    for (const r of ledger) {
      // client_id NULL = the COMPANY wallet (internal campaigns).
      const w = (out[r.client_id ?? COMPANY_KEY] ||= { credited: 0, allocated: 0, balance: 0 })
      if (r.direction === 'credit') w.credited = round2(w.credited + Number(r.amount_inr || 0))
      else w.allocated = round2(w.allocated + Number(r.amount_inr || 0))
    }
    for (const w of Object.values(out)) w.balance = round2(w.credited - w.allocated)
    return out
  }, [ledger])

  const ledgerByClient = useMemo(() => {
    const out: Record<string, LedgerRowView[]> = {}
    for (const r of ledger) (out[r.client_id ?? COMPANY_KEY] ||= []).push(r)
    return out
  }, [ledger])

  const cards: CardData[] = useMemo(
    () => buildCampaignCards(initialProjects, metricsByProject, allocatedByProject, benchmarksByProject, range),
    [initialProjects, metricsByProject, allocatedByProject, benchmarksByProject, range],
  )

  // Card-level filters (shared by both views).
  const q = search.trim().toLowerCase()
  const cardMatches = (c: CardData) => {
    if (q && !c.p.campaign_name.toLowerCase().includes(q) && !(c.p.client?.name ?? '').toLowerCase().includes(q)) return false
    if (fStatus && c.p.status !== fStatus) return false
    if (fPlatform && c.p.platform !== fPlatform) return false
    if (fClient && c.p.client?.id !== fClient) return false
    if (fArchived ? !c.p.archived_at : c.p.archived_at) return false
    if (fMonth) {
      const d = c.p.start_date || c.p.created_at
      if (!d || String(d).slice(0, 7) !== fMonth) return false
    }
    return true
  }
  const filteredCards = cards.filter(cardMatches)
  const cardFiltersActive = Boolean(fStatus || fPlatform || fMonth || q)

  // Group by client (clients with wallet activity but no campaigns still show).
  const groups: ClientGroup[] = useMemo(() => {
    const byId: Record<string, ClientGroup> = {}
    const ensure = (id: string, name: string, code: string) =>
      (byId[id] ||= { clientId: id, name, code, cards: [], wallet: walletByClient[id] || { credited: 0, allocated: 0, balance: 0 }, metaSpend: 0 })

    for (const c of filteredCards) {
      if (!c.p.client?.id) {
        // Company (internal) campaigns get their own first-class section with
        // the company wallet; other clientless cards stay in `unassigned`.
        if (c.p.scope === 'company') {
          const g = ensure(COMPANY_KEY, 'Cirqle — Company', '')
          g.cards.push(c)
          g.metaSpend = round2(g.metaSpend + (c.agg.spend || 0))
        }
        continue
      }
      const g = ensure(c.p.client.id, c.p.client.name, c.p.client.code)
      g.cards.push(c)
      g.metaSpend = round2(g.metaSpend + (c.agg.spend || 0))
    }
    if (!cardFiltersActive) {
      for (const clientId of Object.keys(walletByClient)) {
        if (byId[clientId]) continue
        if (fClient && clientId !== fClient) continue
        if (clientId === COMPANY_KEY) { ensure(COMPANY_KEY, 'Cirqle — Company', ''); continue }
        const meta = clients.find(cl => cl.id === clientId)
        ensure(clientId, meta?.name || 'Unknown client', meta?.code || '')
      }
    }
    let list = Object.values(byId).sort((a, b) => a.name.localeCompare(b.name))
    if (fBalance !== 'all') {
      list = list.filter(g => {
        const w = g.wallet
        if (fBalance === 'positive') return w.balance > 0
        if (fBalance === 'negative') return w.balance < 0
        if (fBalance === 'low') return w.credited > 0 && w.balance >= 0 && w.balance <= w.credited * 0.1
        return true
      })
    }
    return list
  }, [filteredCards, walletByClient, clients, fClient, fBalance, cardFiltersActive])

  const unassigned = filteredCards.filter(c => !c.p.client?.id && c.p.scope !== 'company')

  const platforms = useMemo(
    () => [...new Set(initialProjects.map(p => p.platform).filter(Boolean))],
    [initialProjects],
  )

  // Totals for the KPI strip — for the selected period, excluding archived.
  // Results are grouped by objective result: a cross-campaign "Leads" or
  // "ROAS" total mixed lead, messaging and awareness campaigns into one
  // misleading number.
  const totals = useMemo(() => {
    const live = cards.filter(c => !c.p.archived_at)
    const spend = live.reduce((s, c) => s + (c.periodAgg.spend || 0), 0)
    const revenue = live.reduce((s, c) => s + (c.periodAgg.revenue || 0), 0)
    const byResult = new Map<string, { label: string; costLabel: string; count: number; spend: number }>()
    for (const c of live) {
      const m = c.definition.metric
      if (!m) continue
      const n = c.periodResults
      if (n == null) continue
      const g = byResult.get(m) ?? { label: c.definition.label, costLabel: c.definition.costLabel, count: 0, spend: 0 }
      g.count += n
      g.spend += c.periodAgg.spend || 0
      byResult.set(m, g)
    }
    const synced = live.filter(c => c.p.sync_enabled && c.p.ad_account_id && c.p.status === 'active')
    const stale = synced.filter(c => freshness(c.p).stale).length
    const walletBalance = Object.values(walletByClient).reduce((s, w) => s + w.balance, 0)
    return {
      spend, revenue,
      results: [...byResult.values()],
      synced: synced.length, stale,
      active: live.filter(c => c.p.status === 'active').length,
      walletBalance: round2(walletBalance),
    }
  }, [cards, walletByClient])

  // Needs attention: rules in lib/advertising/attention.ts.
  const attentionItems = useMemo(
    () => computeAttentionItems(attention, cards, metricsByProject, walletSupported),
    [attention, cards, metricsByProject, walletSupported],
  )

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 space-y-6">

      <Link href="/dashboard/apps" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-2">
        <ArrowLeft className="w-4 h-4" /> Back to Apps Directory
      </Link>

      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Megaphone className="h-6 w-6 text-pink-500" />
            Advertising
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Client wallets, campaigns, live KPIs — Cashbook is the financial source of truth.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/dashboard/connections"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:border-pink-500/40 transition-colors"
          >
            <Link2 className="h-4 w-4 text-pink-500" />
            Ad Accounts
          </Link>
          {perms.create && (
            <Link
              href="/dashboard/advertising/new"
              className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              <Plus className="h-4 w-4" />
              New Campaign
            </Link>
          )}
        </div>
      </div>

      {/* ── Migration notices ── */}
      {!migrated && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-semibold text-amber-700 dark:text-amber-400">Database tables not set up</div>
            <div className="text-sm text-amber-600/80 dark:text-amber-400/80 mt-0.5">
              Run <code className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs">20260628120000_advertising_module.sql</code> in your Supabase SQL editor, then refresh.
            </div>
          </div>
        </div>
      )}
      {/* viewFinancials gate: for handlers the server intentionally sends no
          wallet data — that is permission stripping, not a missing migration,
          so the run-the-migration notice must not show for them. */}
      {migrated && !walletSupported && perms.viewFinancials && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-semibold text-amber-700 dark:text-amber-400">Client wallets not set up</div>
            <div className="text-sm text-amber-600/80 dark:text-amber-400/80 mt-0.5">
              Run <code className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs">20260703140000_ad_wallet_ledger.sql</code> to enable wallet balances, fund allocation, and allocation history.
            </div>
          </div>
        </div>
      )}

      {/* ── KPI Summary ── */}
      {migrated && cards.length > 0 && (
        /* grid-cols-1 explicit at base: without it, CSS Grid's implicit
           column has no minmax(0,1fr) constraint below sm, so it sizes to
           the max-content width of the widest KPI card instead of the
           viewport — the whole row (and every child in it) silently grew
           past the screen edge on phones. Same root cause as the campaign-
           card grid below. */
        <div className="space-y-3">
          {/* Period selector — drives every spend/result number below. */}
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Reporting period">
            {PERIODS.map(p => (
              <button
                key={p.key}
                onClick={() => setPeriod(p.key)}
                aria-pressed={period === p.key}
                className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                  period === p.key ? 'border-pink-500/40 bg-pink-500/10 text-pink-600 dark:text-pink-400' : 'border-border bg-card text-muted-foreground hover:text-foreground'
                }`}
              >
                {p.label}
              </button>
            ))}
            <span className="text-xs text-muted-foreground">{range.from ? `${range.from} → ${range.to}` : `up to ${range.to}`}</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard icon={Zap} label="Active" value={totals.active} sub={`of ${cards.filter(c => !c.p.archived_at).length} campaigns`} accent />
            <KpiCard icon={Wallet} label="Spend" value={inr(totals.spend)} sub={`${range.label} · excl. GST`} />
            {totals.results.length > 0
              ? totals.results.slice(0, 3).map(r => (
                  <KpiCard key={r.label} icon={Target} label={r.label} value={r.count.toLocaleString('en-IN')}
                    sub={r.count > 0 ? `${r.costLabel} ${inr(r.spend / r.count, 2)}` : 'none in this period'} />
                ))
              : <KpiCard icon={Target} label="Results" value="—" sub="No objective results in this period" />}
            {totals.revenue > 0 && (
              <KpiCard icon={TrendingUp} label="Revenue" value={inr(totals.revenue)} sub={`ROAS ${(totals.revenue / Math.max(totals.spend, 1)).toFixed(2)}× · platform-attributed`} />
            )}
            <KpiCard icon={RefreshCw} label="Data freshness"
              value={totals.synced === 0 ? '—' : totals.stale === 0 ? 'Up to date' : `${totals.stale} stale`}
              sub={totals.synced === 0 ? 'No auto-synced active campaigns' : `${totals.synced} auto-synced active campaign${totals.synced === 1 ? '' : 's'}`} />
            {/* Wallet balance is wallet-layer data (view_financials). */}
            {walletSupported && perms.viewFinancials && (
              <KpiCard icon={Wallet} label="Wallet Balance" value={inr(totals.walletBalance)} sub="across all clients" />
            )}
          </div>
        </div>
      )}

      {/* ── Needs attention ── */}
      {migrated && attention && cards.length > 0 && (
        <AttentionPanel items={attentionItems} canSnooze={perms.edit && attention.snoozeSupported} />
      )}

      {/* ── Pending requests ── */}
      {perms.create && pendingRequests.length > 0 && (
        <PendingRequestsSection requests={pendingRequests} />
      )}

      {/* ── Empty state ── */}
      {migrated && cards.length === 0 && pendingRequests.length === 0 && (
        <EmptyState canCreate={perms.create} />
      )}

      {/* ── View toggle + filters ── */}
      {cards.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
            {([['clients', 'By Client'], ['all', 'All Campaigns']] as [ViewMode, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setView(key)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  view === key ? 'bg-pink-500/10 text-pink-600 dark:text-pink-400' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <label className="relative">
            <span className="sr-only">Search campaigns or clients</span>
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search campaigns or clients"
              className="w-56 max-w-full rounded-lg border border-border bg-card py-1.5 pl-7 pr-2.5 text-xs"
            />
          </label>
          <select value={fClient} onChange={e => setFClient(e.target.value)}
            className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs">
            <option value="">All clients</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={fStatus} onChange={e => setFStatus(e.target.value)}
            className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs">
            <option value="">All statuses</option>
            {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <select value={fPlatform} onChange={e => setFPlatform(e.target.value)}
            className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs">
            <option value="">All platforms</option>
            {platforms.map(p => <option key={p} value={p}>{PLATFORM_LABEL[p] || p}</option>)}
          </select>
          <input
            type="month" value={fMonth} onChange={e => setFMonth(e.target.value)}
            className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs"
            title="Campaign month (start date)"
          />
          {walletSupported && perms.viewFinancials && (
            <select value={fBalance} onChange={e => setFBalance(e.target.value as BalanceFilter)}
              className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs">
              <option value="all">Any balance</option>
              <option value="positive">Balance available</option>
              <option value="low">Low balance (≤10%)</option>
              <option value="negative">Negative balance</option>
            </select>
          )}
          <button
            onClick={() => setFArchived(!fArchived)}
            className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              fArchived 
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400' 
                : 'border-border bg-card text-muted-foreground hover:text-foreground'
            }`}
          >
            {fArchived ? 'Viewing Archived' : 'Show Archived'}
          </button>
          {(q || fClient || fStatus || fPlatform || fMonth || fBalance !== 'all' || fArchived) && (
            <button
              onClick={() => { setSearch(''); setFClient(''); setFStatus(''); setFPlatform(''); setFMonth(''); setFBalance('all'); setFArchived(false) }}
              className="text-xs text-muted-foreground hover:text-foreground underline"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* ── By Client view ── */}
      {view === 'clients' && groups.map(g => (
        <ClientSection
          key={g.clientId}
          group={g}
          history={ledgerByClient[g.clientId] || []}
          candidates={fundCandidates}
          walletSupported={walletSupported}
          canManage={perms.manageBudget}
          viewFinancials={perms.viewFinancials}
          viewBilling={perms.viewBilling}
        />
      ))}
      {view === 'clients' && unassigned.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Unassigned ({unassigned.length})
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {unassigned.map(c => <CampaignCard key={c.p.id} card={c} walletOn={walletSupported} showBilling={perms.viewBilling} />)}
          </div>
        </div>
      )}
      {view === 'clients' && groups.length === 0 && unassigned.length === 0 && cards.length > 0 && (
        <p className="text-sm text-muted-foreground py-8 text-center">No clients match the current filters.</p>
      )}

      {/* ── All Campaigns view (flat grid) ── */}
      {view === 'all' && filteredCards.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Campaigns ({filteredCards.length})
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {filteredCards.map(c => <CampaignCard key={c.p.id} card={c} walletOn={walletSupported} showBilling={perms.viewBilling} />)}
            <Link
              href="/dashboard/connections"
              className="group rounded-xl border border-dashed border-border bg-card/50 p-5 flex flex-col items-center justify-center gap-2 hover:border-pink-500/40 hover:bg-card transition-all text-center"
            >
              <div className="h-10 w-10 rounded-xl bg-pink-500/10 flex items-center justify-center">
                <Link2 className="h-5 w-5 text-pink-500" />
              </div>
              <div className="text-sm font-medium">Connect Ad Account</div>
              <div className="text-xs text-muted-foreground">Link Meta or Google to auto-sync</div>
              <div className="mt-1 text-xs text-pink-500 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                Go to integrations <ArrowRight className="h-3 w-3" />
              </div>
            </Link>
          </div>
        </div>
      )}
      {view === 'all' && filteredCards.length === 0 && cards.length > 0 && (
        <p className="text-sm text-muted-foreground py-8 text-center">No campaigns match the current filters.</p>
      )}
    </div>
  )
}

// ─── Needs attention ─────────────────────────────────────────────────────────

const SEVERITY_STYLE = {
  critical: { dot: 'bg-red-500', text: 'Critical' },
  warning:  { dot: 'bg-amber-500', text: 'Warning' },
  info:     { dot: 'bg-sky-500', text: 'Info' },
} as const

export function AttentionPanel({ items, canSnooze }: { items: AttentionItem[]; canSnooze: boolean }) {
  const router = useRouter()
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const shown = expanded ? items : items.slice(0, 5)

  async function snooze(key: string, days: number) {
    setBusy(key); setError(null)
    const res = await snoozeAttention(key, days)
    setBusy(null)
    if (res.ok) router.refresh()
    else setError(res.error ?? 'Could not snooze.')
  }

  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
        <CheckCircle2 className="h-4 w-4 text-emerald-500" /> Nothing needs attention right now.
      </div>
    )
  }

  return (
    <section aria-labelledby="needs-attention" className="rounded-xl border border-amber-500/30 bg-amber-500/[0.04]">
      <div className="flex items-center justify-between gap-2 border-b border-amber-500/20 px-4 py-3">
        <h2 id="needs-attention" className="flex items-center gap-2 text-sm font-semibold">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          Needs attention <span className="text-xs font-normal text-muted-foreground">({items.length})</span>
        </h2>
        {error && <span role="alert" className="text-xs text-red-500">{error}</span>}
      </div>
      <ul className="divide-y divide-border">
        {shown.map(i => (
          <li key={i.key} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <span className={`h-2 w-2 shrink-0 rounded-full ${SEVERITY_STYLE[i.severity].dot}`} aria-hidden />
                <span className="sr-only">{SEVERITY_STYLE[i.severity].text}:</span>
                {i.title}
                {(i.clientName || i.campaignName) && (
                  <span className="text-xs font-normal text-muted-foreground truncate">
                    {[i.clientName, i.campaignName].filter(Boolean).join(' · ')}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {i.reason}{i.owner ? <> · Owner {i.owner}</> : null}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Link href={i.href} className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium hover:border-pink-500/40">
                {i.action} <ArrowRight className="h-3 w-3" />
              </Link>
              {canSnooze && (
                <button
                  onClick={() => snooze(i.key, 3)} disabled={busy === i.key}
                  title="Hide for 3 days"
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {busy === i.key ? <Loader2 className="h-3 w-3 animate-spin" /> : <BellOff className="h-3 w-3" />} Snooze
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {items.length > 5 && (
        <button onClick={() => setExpanded(v => !v)} className="w-full border-t border-border px-4 py-2 text-xs text-muted-foreground hover:text-foreground">
          {expanded ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
      {!canSnooze && (
        <p className="flex items-center gap-1 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3" /> Items clear by themselves once the underlying issue is fixed.
        </p>
      )}
    </section>
  )
}

// ─── Client section (wallet + campaigns) ─────────────────────────────────────

/** Synthetic group key for Cirqle's own (company) wallet + internal campaigns. */
export const COMPANY_KEY = '__company__'

function ClientSection({ group, history, candidates, walletSupported, canManage, viewFinancials, viewBilling }: {
  group: ClientGroup
  history: LedgerRowView[]
  candidates: FundCandidate[]
  walletSupported: boolean
  canManage: boolean
  viewFinancials: boolean
  viewBilling: boolean
}) {
  const router = useRouter()
  const [showAdd, setShowAdd] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const w = group.wallet
  const spendGross = spendWithGst(group.metaSpend) // actual money consumed (incl. 18% GST)
  const unspent = round2(w.allocated - spendGross)

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Client header + wallet */}
      <div className="border-b border-border bg-muted/30 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {group.clientId === COMPANY_KEY
              ? <span className="font-semibold truncate">{group.name}</span>
              : <Link href={`/dashboard/advertising/clients/${group.clientId}`} className="font-semibold truncate hover:underline">{group.name}</Link>}
            {group.code && <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">{group.code}</span>}
            <span className="text-xs text-muted-foreground">· {group.cards.length} campaign{group.cards.length === 1 ? '' : 's'}</span>
          </div>
          {/* History lists top-ups (what the client paid) — wallet layer. */}
          {walletSupported && viewFinancials && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowHistory(v => !v)}
                className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium hover:bg-secondary"
              >
                <History className="h-3.5 w-3.5" /> History
                <ChevronDown className={`h-3 w-3 transition-transform ${showHistory ? 'rotate-180' : ''}`} />
              </button>
              {canManage && (
                <button
                  onClick={() => setShowAdd(v => !v)}
                  className="inline-flex items-center gap-1 rounded-lg gradient-bg px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90"
                >
                  <Plus className="h-3.5 w-3.5" /> Add Funds
                </button>
              )}
            </div>
          )}
        </div>

        {walletSupported && (
          /* 'GST 18%' stat dropped: pure derivation of Meta Spend × 18%,
             already folded into 'Unspent (incl. GST)' — one less repeated
             number per client row.
             Credited / Remaining Balance are wallet-layer (view_financials);
             allocations + spend are the working budget every viewer gets. */
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {viewFinancials && <WalletStat label="Wallet Credited" value={inr(w.credited, 2)} />}
            <WalletStat label="Campaign Allocated" value={inr(w.allocated, 2)} />
            {viewFinancials && <WalletStat label="Remaining Balance" value={inr(w.balance, 2)} tone={w.balance < 0 ? 'bad' : w.balance > 0 ? 'good' : undefined} />}
            <WalletStat label="Meta Spend (excl. GST)" value={inr(group.metaSpend, 2)} />
            <WalletStat label="Unspent (incl. GST)" value={inr(unspent, 2)} tone={unspent < 0 ? 'bad' : undefined} />
          </div>
        )}

        {showAdd && canManage && walletSupported && viewFinancials && (
          <AddFundsForm
            clientId={group.clientId === COMPANY_KEY ? null : group.clientId}
            candidates={candidates}
            onDone={() => { setShowAdd(false); router.refresh() }}
          />
        )}

        {showHistory && walletSupported && viewFinancials && (
          <LedgerHistory rows={history} canManage={canManage} onChange={() => router.refresh()} />
        )}
      </div>

      {/* Campaign cards.
          grid-cols-1 explicit: confirmed live at 375px via getComputedStyle
          — without it this grid's implicit base-breakpoint column sized to
          437px (max-content of the card) instead of the 335px container,
          so the whole card silently rendered wider than the viewport
          (KPI grid's 4th column and the Billing row both "cut off" were
          symptoms of THIS, not independent bugs). */}
      {group.cards.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
          {group.cards.map(c => <CampaignCard key={c.p.id} card={c} walletOn={walletSupported} showBilling={viewBilling} />)}
        </div>
      ) : (
        <p className="px-4 py-6 text-xs text-muted-foreground">No campaigns yet for this client.</p>
      )}
    </div>
  )
}

export function WalletStat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-lg bg-card border border-border px-3 py-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${tone === 'bad' ? 'text-red-500' : tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>
        {value}
      </div>
    </div>
  )
}

export function AddFundsForm({ clientId, candidates, onDone }: {
  /** null = the COMPANY wallet (internal campaigns). */
  clientId: string | null
  candidates: FundCandidate[]
  onDone: () => void
}) {
  const [entryId, setEntryId] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const usable = candidates.filter(c => c.uncredited > 0)

  function pick(id: string) {
    setEntryId(id)
    const c = candidates.find(x => x.id === id)
    if (c) setAmount(String(c.uncredited))
  }

  async function submit() {
    if (!entryId) { setErr('Pick a cashbook entry.'); return }
    setBusy(true); setErr(null)
    const input = { cashbookEntryId: entryId, amount: Number(amount) || 0 }
    const res = clientId ? await addClientFund(clientId, input) : await addCompanyFund(input)
    setBusy(false)
    if (res.ok) onDone()
    else setErr(res.error || 'Could not add funds.')
  }

  return (
    <div className="mt-3 rounded-lg border border-border bg-card p-3 space-y-2">
      <div className="text-xs font-medium">
        {clientId
          ? <>Credit this client&apos;s wallet from a Cashbook payment (e.g. a Meta top-up)</>
          : <>Credit the company wallet from a Cashbook payment — funds Cirqle&apos;s own campaigns, never invoiced</>}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[220px]">
          <label className="block text-[10px] font-medium text-muted-foreground mb-1">Cashbook entry (outflow)</label>
          <select value={entryId} onChange={e => pick(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs">
            <option value="">Select an entry…</option>
            {usable.map(c => (
              <option key={c.id} value={c.id}>
                {c.entry_date} — {c.description || c.reference || 'Entry'} · {inr(c.uncredited, 2)} unassigned of {inr(c.amount, 2)}
              </option>
            ))}
          </select>
        </div>
        <div className="w-36">
          <label className="block text-[10px] font-medium text-muted-foreground mb-1">Amount</label>
          <input type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs tabular-nums" />
        </div>
        <button onClick={submit} disabled={busy || !entryId}
          className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-50">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Credit wallet
        </button>
      </div>
      {usable.length === 0 && (
        <p className="text-[11px] text-muted-foreground">No outflow entries with unassigned funds — record the top-up payment in the Cashbook first.</p>
      )}
      {err && <p className="text-[11px] text-red-500">{err}</p>}
    </div>
  )
}

export function LedgerHistory({ rows, canManage, onChange }: {
  rows: LedgerRowView[]
  canManage: boolean
  onChange: () => void
}) {
  const { dn } = usePrivacy()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function remove(id: string) {
    setBusy(id); setErr(null)
    const res = await removeWalletTransaction(id)
    setBusy(null)
    if (res.ok) onChange()
    else setErr(res.error || 'Could not reverse the transaction.')
  }

  if (rows.length === 0) {
    return <p className="mt-3 text-xs text-muted-foreground">No wallet transactions yet.</p>
  }

  return (
    <div className="mt-3 rounded-lg border border-border bg-card divide-y divide-border max-h-72 overflow-y-auto">
      {err && <p className="px-3 py-2 text-[11px] text-red-500">{err}</p>}
      {rows.map(r => {
        const credit = r.direction === 'credit'
        const what = credit
          ? `Top-up${r.entry?.description ? ` — ${r.entry.description}` : ''}${r.entry?.reference ? ` (${r.entry.reference})` : ''}`
          : `→ ${r.project?.campaign_name || 'Campaign allocation'}`
        return (
          <div key={r.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <div className="flex items-center gap-2 min-w-0">
              {credit
                ? <ArrowDownLeft className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                : <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-pink-500" />}
              <div className="min-w-0">
                <div className="text-xs truncate">{what}{r.notes ? <span className="text-muted-foreground"> · {r.notes}</span> : null}</div>
                <div className="text-[10px] text-muted-foreground">
                  {new Date(r.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  {r.creator ? ` · ${dn(r.creator)}` : ''}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className={`text-xs font-semibold tabular-nums ${credit ? 'text-emerald-600 dark:text-emerald-400' : 'text-pink-600 dark:text-pink-400'}`}>
                {credit ? '+' : '−'}{inr(r.amount_inr, 2)}
              </span>
              {canManage && (
                <button onClick={() => remove(r.id)} disabled={busy === r.id} title="Reverse this transaction"
                  className="text-muted-foreground hover:text-red-500 disabled:opacity-50">
                  {busy === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Campaign card ────────────────────────────────────────────────────────────

export function CampaignCard({ card, walletOn, showBilling }: { card: CardData; walletOn: boolean; showBilling: boolean }) {
  const { p, agg, health, days, allocated, billing, stats } = card
  const fresh = freshness(p)
  return (
    <Link
      href={`/dashboard/advertising/${p.id}`}
      className="group relative rounded-xl border border-border bg-card p-5 hover:border-pink-500/40 hover:shadow-md transition-all"
    >
      {/* Card header */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <div className="font-semibold truncate leading-tight">{p.campaign_name}</div>
          <div className="text-xs text-muted-foreground mt-0.5 truncate">
            {p.client?.name || 'No client'}
            {' · '}
            {PLATFORM_LABEL[p.platform] || p.platform}
            {p.campaign_type ? ` · ${CAMPAIGN_TYPE_LABEL[p.campaign_type] || p.campaign_type}` : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Discuss opens the campaign's chat room in a slide-over. The card
              itself is an <a>; capture-phase preventDefault cancels the
              navigation while the button's own onClick still runs (the
              button stops propagation, so this wrapper never mis-cancels a
              plain card click — those never pass through it). */}
          <span onClickCapture={e => e.preventDefault()}>
            <DiscussButton entityType="project" entityId={p.id} variant="icon" label="Discuss this campaign" panelTitle={p.campaign_name} />
          </span>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${AD_STATUS_CHIP[p.status] || ''}`}>
            {STATUS_LABEL[p.status] || p.status}
          </span>
        </div>
      </div>

      {/* Funding: allocated vs GST-inclusive spend (falls back to estimated budget) */}
      <div className="mb-3 rounded-lg bg-secondary/50 px-3 py-2">
        <div className="flex items-center justify-between text-xs font-medium">
          <span className="text-muted-foreground">{walletOn && allocated > 0 ? 'Allocated' : 'Budget'}</span>
          <span>{walletOn && allocated > 0 ? inr(allocated) : inr(p.ad_budget_amount)}</span>
        </div>
        {/* Financial progress uses actual money consumed = reported spend + 18% GST */}
        <BudgetBar spent={spendWithGst(agg.spend || 0)} total={walletOn && allocated > 0 ? allocated : (p.ad_budget_amount || 0)} />
        {walletOn && (
          // flex-wrap: on phones "Billing: ₹X (Y%)" + "Remaining alloc: ₹Z"
          // together don't fit one line — unwrapped, the row had no way to
          // shrink and forced the ENTIRE campaign card wider than the
          // viewport (the KPI grid below inherited the overflow as a
          // symptom, not a cause).
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
            {/* Billing = agency margin — view_billing only (the server sends
                null charge fields without it, so this would render ₹0). */}
            {showBilling && (
              <span>Billing: <span className="font-semibold text-foreground">{inr(billing, 2)}</span>
                {p.service_charge_type === 'percent' ? ` (${p.service_charge_value}%)` : ''}
              </span>
            )}
            {allocated > 0 && <span>Remaining alloc: {inr(Math.max(0, round2(allocated - spendWithGst(agg.spend || 0))))}</span>}
          </div>
        )}
      </div>

      {/* Objective-led KPIs for the selected period (objective-stats.ts) */}
      <div className="grid grid-cols-4 gap-2">
        {stats.map(t => <MiniStat key={t.label} label={t.label} value={t.value} />)}
      </div>

      {/* Footer */}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
        <HealthBadge health={health} />
        <span className={`text-[10px] flex items-center gap-1 ${fresh.stale ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
          <RefreshCw className="h-3 w-3" />{fresh.text}
        </span>
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {days == null ? 'No end date' : days < 0 ? 'Ended' : `${days}d left`}
        </span>
        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </Link>
  )
}

// ─── Empty state + pending requests ──────────────────────────────────────────

function EmptyState({ canCreate }: { canCreate: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card overflow-hidden">
      <div className="p-12 text-center">
        <div className="mx-auto w-14 h-14 rounded-2xl bg-pink-500/10 flex items-center justify-center mb-4">
          <Megaphone className="h-7 w-7 text-pink-500" />
        </div>
        <h2 className="text-lg font-semibold">No campaigns yet</h2>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
          Connect your Meta or Google Ads account to start syncing campaigns, or create one manually.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/dashboard/connections"
            className="inline-flex items-center gap-2 rounded-lg gradient-bg px-4 py-2.5 text-sm font-medium text-white hover:opacity-90"
          >
            <Link2 className="h-4 w-4" />
            Connect Meta / Google Ads
          </Link>
          {canCreate && (
            <Link
              href="/dashboard/advertising/new"
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium hover:border-pink-500/40 transition-colors"
            >
              <Plus className="h-4 w-4" />
              Create manually
            </Link>
          )}
        </div>
      </div>

      {/* How it works */}
      <div className="border-t border-border bg-muted/30 px-8 py-6 grid grid-cols-1 gap-6 sm:grid-cols-3 text-center">
        {[
          { icon: Link2, step: '1', title: 'Connect Ad Account', desc: 'OAuth with Meta or Google — takes 30 seconds.' },
          { icon: Zap, step: '2', title: 'Auto-sync Campaigns', desc: 'Daily metrics pull into your dashboard automatically.' },
          { icon: BarChart3, step: '3', title: 'Track & Optimise', desc: 'ROAS, CTR, spend, leads — all in one place.' },
        ].map(({ step, title, desc }) => (
          <div key={step} className="flex flex-col items-center gap-2">
            <div className="h-9 w-9 rounded-full bg-pink-500/10 flex items-center justify-center text-pink-500 font-bold text-sm">
              {step}
            </div>
            <div className="font-medium text-sm">{title}</div>
            <div className="text-xs text-muted-foreground">{desc}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function PendingRequestsSection({ requests }: { requests: PendingRequest[] }) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function start(id: string) {
    setBusyId(id); setError(null)
    const res = await startAdvertisingRequest(id)
    setBusyId(null)
    if (res.ok && res.data) router.push(`/dashboard/advertising/${res.data.projectId}`)
    else setError(res.error || 'Could not start the campaign.')
  }

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4">
      <div className="flex items-center gap-2 mb-3">
        <Inbox className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <h2 className="text-sm font-semibold">Advertising Requests</h2>
        <span className="text-xs text-muted-foreground">— start one to create a campaign + task</span>
      </div>
      {error && (
        <div className="mb-2 flex items-center gap-2 text-xs text-red-600 bg-red-500/10 rounded-lg px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5" /> {error}
        </div>
      )}
      <div className="space-y-2">
        {requests.map(r => {
          const platform = r.ad_meta?.platform ? PLATFORM_LABEL[r.ad_meta.platform] || r.ad_meta.platform : null
          const budget = r.ad_meta?.ad_budget != null ? inr(Number(r.ad_meta.ad_budget)) : null
          return (
            <div key={r.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{r.title}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {r.ref_no ? `REQ-${String(r.ref_no).padStart(4, '0')} · ` : ''}
                  {r.client?.name || 'No client'}
                  {platform ? ` · ${platform}` : ''}
                  {budget ? ` · ${budget}` : ''}
                </div>
              </div>
              <button
                onClick={() => start(r.id)}
                disabled={busyId === r.id}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-lg gradient-bg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 hover:opacity-90"
              >
                {busyId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                Start
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
