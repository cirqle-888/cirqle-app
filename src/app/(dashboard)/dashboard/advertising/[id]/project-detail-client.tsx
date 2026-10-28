'use client'

/**
 * Advertising project detail — one campaign in four tabs:
 * Overview (results, health, activity) · Performance (daily rows) ·
 * Funds & billing · Reports. Sync & connection settings sit behind the
 * header's settings button. The tab lives in the URL (?tab=); the old tab
 * names (daily, budget, notes, timeline, integrations) still resolve.
 *
 * All money/metric math comes from the shared pure helpers (aggregateMetrics,
 * deriveMetrics, computeBudgetTotals, assessCampaignHealth). Mutations go through the
 * guarded server actions; after each, router.refresh() re-pulls server data.
 */

import React, { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { CreativePerformance } from '@/components/reporting/creative-performance'
import { CampaignReviewTools } from '@/components/reporting/campaign-review-tools'
import { ReportComposer, type ComposerProject } from '@/components/reporting/report-composer'
import type { ClientReportPreferences } from '@/lib/reporting/preferences'
import { usePrivacy } from '@/contexts/privacy-context'
import {
  Megaphone, ArrowLeft, Loader2, Plus, Check, Trash2, FileText, ExternalLink,
  Download, Calendar, CheckCircle, XCircle, Clock, Settings2, RefreshCw,
} from 'lucide-react'
import {
  AD_STATUS_CHIP, STATUS_LABEL, STATUSES, PLATFORM_LABEL, CAMPAIGN_TYPE_LABEL, adRefLabel,
  type AdProjectRow, type AdDailyMetricRow,
} from '@/lib/advertising/types'
import { deriveMetrics, remainingBudget } from '@/lib/advertising/metrics'
import { aggregateMetrics } from '@/lib/advertising/reporting'
import BudgetFields, { emptyBudget, resolveBudget, type BudgetValue } from '../budget-fields'
import {
  updateAdStatus, saveAdBudget, upsertDailyMetric, approveDailyMetric, deleteDailyMetric,
  addAdNote, createInvoiceForProject, setMetricSyncState, softDeleteAdProject,
  allocateToCampaign, removeWalletTransaction, setAdProjectArchived, generateTaskForProject,
  updateAdProject,
} from '../actions'
import { computeServiceCharge, spendWithGst } from '@/lib/advertising/budget'
import { IntegrationsTab } from './integrations-tab'
import { Archive, ArchiveRestore } from 'lucide-react'
import { FavoriteToggle } from '@/components/ui/favorite-toggle'
import { TimelineTab } from '@/components/activity/timeline-tab'
import { DiscussButton } from '@/components/chat/discuss-button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { todayISO } from '@/lib/utils/local-date'
import { CIRQLE_CAMPAIGN_TYPES } from '@/lib/advertising/campaign-objective'
import type { BenchmarkMetrics, BenchmarkSource } from '@/lib/advertising/ai/benchmarks'
import type { HealthScoreResult } from '@/lib/advertising/ai/scoring'
import { generateForecast } from '@/lib/advertising/ai/forecasting'
import { assessCampaignHealth, healthLabel } from '@/lib/reporting/campaign-health'
import { resultDefinitionFor, resultCount, costPerSelectedResult, type ResultDefinition } from '@/lib/reporting/result-type'
import { syncFreshness } from '@/lib/advertising/freshness'

type Project = AdProjectRow & { 
  client?: { id: string; name: string; code: string } | null,
  archived_at?: string | null
}

export interface CampaignAllocation {
  id: string
  amount: number
  amount_inr: number
  notes: string | null
  created_at: string
  creator?: { id: string; name: string; cqid?: string } | null
}

export interface WalletSummaryView {
  /** null = the COMPANY wallet (internal campaigns). */
  clientId: string | null
  creditedInr: number
  allocatedInr: number
  balanceInr: number
}

interface Props {
  project: Project
  metrics: AdDailyMetricRow[]
  tasks: { id: string; task_number: number | null; title: string; status: string; billing_amount: number }[]
  notes: { id: string; body: string; created_at: string; author?: { cqid?: string; name?: string } | null }[]
  invoice: { id: string; invoice_number: string; status: string; total_amount: number } | null
  services?: { id: string; name: string; pricing_type: string | null; default_price: number | null }[]
  servicePricing?: { client_id: string; service_id: string; price: number }[]
  allocations?: CampaignAllocation[]
  wallet?: WalletSummaryView | null
  allocSupported?: boolean
  /** Report benchmark tiers for this campaign (null when unavailable). */
  benchmarks?: { metrics: BenchmarkMetrics; source: BenchmarkSource } | null
  /** The client's campaigns, for the report composer (this one included). */
  clientCampaigns?: ComposerProject[]
  reportPreferences?: Record<string, ClientReportPreferences>
  reportPreferencesSupported?: boolean
  /** Platform-side status (may lag) and Ads Manager deep link; null = not linked. */
  platform?: { provider: string | null; status: string | null; statusSeenAt: string | null; adsManagerUrl: string | null } | null
  perms: { edit: boolean; manageBudget: boolean; enterMetrics: boolean; approveMetrics: boolean; viewFinancials: boolean; viewBilling: boolean }
}

const inr = (v: number | null | undefined, dp = 0) =>
  v == null ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: dp })}`
const num = (v: number | null | undefined) =>
  v == null ? '—' : Number(v).toLocaleString('en-IN')
const round2 = (v: number) => Math.round(v * 100) / 100

type Tab = 'overview' | 'performance' | 'funds' | 'reports'

/** Old tab names (bookmarks, alert links) → the merged tabs. */
const LEGACY_TAB: Record<string, Tab> = {
  overview: 'overview', notes: 'overview', timeline: 'overview', integrations: 'overview',
  daily: 'performance', performance: 'performance',
  budget: 'funds', funds: 'funds',
  reports: 'reports',
}

export default function ProjectDetailClient({ project, metrics, tasks, notes, invoice, services, servicePricing, allocations = [], wallet = null, allocSupported = false, benchmarks = null, platform = null, clientCampaigns = [], reportPreferences = {}, reportPreferencesSupported = false, perms }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const requested = searchParams.get('tab') ?? 'overview'
  const canSeeFunds = perms.viewFinancials || perms.viewBilling
  const resolvedTab: Tab = LEGACY_TAB[requested] ?? 'overview'
  const [tab, setTabState] = useState<Tab>(resolvedTab === 'funds' && !canSeeFunds ? 'overview' : resolvedTab)
  const [showSettings, setShowSettings] = useState(requested === 'integrations')
  const [showTimeline, setShowTimeline] = useState(requested === 'timeline')
  function setTab(next: Tab) {
    setTabState(next)
    const q = new URLSearchParams(searchParams.toString())
    if (next === 'overview') q.delete('tab'); else q.set('tab', next)
    // Native history: updates useSearchParams without a server round trip
    // (Next.js integrates replaceState with the router).
    window.history.replaceState(null, '', q.size ? `${pathname}?${q}` : pathname)
  }
  const fresh = syncFreshness(project)
  // Old ?tab=notes / ?tab=timeline links land on the Activity section.
  useEffect(() => {
    if (requested === 'notes' || requested === 'timeline') {
      document.getElementById('activity')?.scrollIntoView({ block: 'start' })
    }
  }, [requested])
  const [status, setStatus] = useState(project.status)

  const agg = useMemo(() => aggregateMetrics(metrics), [metrics])
  const remaining = remainingBudget(project.ad_budget_amount, agg.spend)
  // The objective's result (conversations, purchases, leads…) and its cost —
  // the same definitions reports use (result-type.ts).
  const result = useMemo(() => {
    const definition = resultDefinitionFor(project.campaign_type, { leads: agg.leads })
    const count = resultCount(definition, agg)
    return { definition, count, cost: costPerSelectedResult(agg.spend, count) }
  }, [project.campaign_type, agg])

  // Lifetime health under the report's rules (campaign-health.ts).
  const health = useMemo(() => {
    const today = todayISO()
    const dates = metrics.map(m => m.metric_date).sort()
    const roasPoints = [...metrics]
      .sort((a, b) => a.metric_date.localeCompare(b.metric_date))
      .map(m => ({ date: m.metric_date, value: Number(m.spend) > 0 ? Number(m.revenue || 0) / Number(m.spend) : 0 }))
    return assessCampaignHealth({
      spend: agg.spend, revenue: agg.revenue, roas: agg.roas, ctr: agg.ctr, cpc: agg.cpc,
      conversionRate: agg.clicks > 0 ? (agg.leads / agg.clicks) * 100 : 0,
      results: result.count, costPerResult: result.cost,
      budget: Number(project.ad_budget_amount || 0),
      campaignStart: project.start_date, campaignEnd: project.end_date,
      periodFrom: project.start_date ?? dates[0] ?? today,
      periodTo: today,
      today,
      benchmarks: benchmarks?.metrics ?? null,
      benchmarkSource: benchmarks?.source ?? null,
      forecasts: agg.revenue > 0 && roasPoints.length > 1 ? { roas: generateForecast(roasPoints, 30) } : undefined,
    })
  }, [project, agg, metrics, result, benchmarks])

  const [deleting, setDeleting] = useState(false)
  const [archiving, setArchiving] = useState(false)
  // In-app confirmation. NOT window.confirm: the desktop shell returns false
  // from it immediately without ever drawing a dialog, so Archive and Delete
  // would sit there dead with no error to explain it.
  const [confirmPrompt, setConfirmPrompt] = useState<{
    title: string
    body: string
    confirmLabel: string
    danger?: boolean
    onConfirm: () => void
  } | null>(null)

  async function onStatus(v: string) {
    setStatus(v)
    await updateAdStatus(project.id, v)
    router.refresh()
  }

  async function onDelete() {
    setDeleting(true)
    const res = await softDeleteAdProject(project.id)
    if (res.ok) router.push('/dashboard/advertising')
    else { alert(res.error || 'Failed to delete.'); setDeleting(false) }
  }

  async function onToggleArchive() {
    const isArchived = !!project.archived_at
    setArchiving(true)
    const res = await setAdProjectArchived(project.id, !isArchived)
    setArchiving(false)
    if (res.ok) router.refresh()
    else alert(res.error || 'Failed to update archive status.')
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'performance', label: `Performance${metrics.length ? ` (${metrics.length})` : ''}` },
    // Funds & billing is the money-management tab (service charge config,
    // wallet allocation, invoicing) — needs at least one money layer; a plain
    // handler sees allocations in the Overview instead.
    ...(canSeeFunds ? [{ key: 'funds', label: 'Funds & billing' } as const] : []),
    { key: 'reports', label: 'Reports' },
  ]
  const def = result.definition

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-6">
      {/* Header */}
      <div>
        <Link href="/dashboard/advertising" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Advertising
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <Megaphone className="h-5 w-5 text-pink-500" /> {project.campaign_name}
              {project.archived_at && (
                <span className="ml-2 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 px-2 py-0.5 text-xs font-semibold">
                  Archived
                </span>
              )}
              <FavoriteToggle
                entityType="campaign"
                entityId={project.id}
                href={`/dashboard/advertising/${project.id}`}
                label={project.campaign_name}
                iconKey="Megaphone"
              />
              <DiscussButton entityType="project" entityId={project.id} variant="icon" label="Discuss this campaign" panelTitle={project.campaign_name} />
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {adRefLabel(project.id)} · {project.client?.name || 'No client'} · {PLATFORM_LABEL[project.platform] || project.platform}
              {project.campaign_type ? ` · ${CAMPAIGN_TYPE_LABEL[project.campaign_type] || project.campaign_type}` : ''}
            </p>
            {/* The campaign in one line: objective result, cost, dates, freshness. */}
            <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              {def.metric ? (
                <span><strong className="tabular-nums">{num(result.count)}</strong> {def.label.toLowerCase()}
                  {result.cost != null && <> · <strong className="tabular-nums">{inr(result.cost, 2)}</strong> {def.costLabel.toLowerCase().replace('cost per', 'per')}</>}
                </span>
              ) : (
                <span className="text-muted-foreground">{def.unavailableReason ?? 'No result metric for this objective'}</span>
              )}
              <span className="text-muted-foreground">
                <Calendar className="mr-1 inline h-3.5 w-3.5" />{project.start_date || '—'} → {project.end_date || 'ongoing'}
              </span>
              <span className={fresh.stale ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>
                <RefreshCw className="mr-1 inline h-3.5 w-3.5" />{fresh.text}
              </span>
              {platform?.adsManagerUrl && (
                <a href={platform.adsManagerUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-pink-600 hover:underline dark:text-pink-400">
                  Open in Ads Manager <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Two statuses, kept apart: Meta's delivery status (read-only,
                as last seen by discovery) and Cirqle's own workflow status. */}
            {platform?.status && (
              <span
                title={platform.statusSeenAt ? `Status on ${PLATFORM_LABEL[platform.provider ?? ''] || platform.provider} as of ${new Date(platform.statusSeenAt).toLocaleString('en-IN')}` : undefined}
                className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-muted-foreground"
              >
                {PLATFORM_LABEL[platform.provider ?? ''] || 'Platform'}: {platform.status.toLowerCase().replace(/_/g, ' ')}
              </span>
            )}
            <button
              onClick={() => setShowSettings(v => !v)}
              aria-expanded={showSettings}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-secondary"
            >
              <Settings2 className="h-3.5 w-3.5" /> Sync &amp; connection
            </button>
            {perms.edit ? (
              <select
                value={status}
                onChange={e => onStatus(e.target.value)}
                className={`rounded-full border px-3 py-1 text-xs font-semibold outline-none ${AD_STATUS_CHIP[status] || ''}`}
              >
                {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            ) : (
              <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${AD_STATUS_CHIP[status] || ''}`}>
                {STATUS_LABEL[status] || status}
              </span>
            )}
            {perms.edit && (
              <>
                <button
                  onClick={() => project.archived_at ? void onToggleArchive() : setConfirmPrompt({
                    title: `Archive "${project.campaign_name}"?`,
                    body: 'The campaign drops out of active lists and stops appearing in day-to-day views. Its spend, metrics and invoices are untouched, and you can unarchive it at any time.',
                    confirmLabel: 'Archive campaign',
                    onConfirm: () => { void onToggleArchive() },
                  })}
                  disabled={archiving}
                  title={project.archived_at ? 'Unarchive campaign' : 'Archive campaign'}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-50 transition-colors"
                >
                  {archiving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : project.archived_at ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                  {project.archived_at ? 'Unarchive' : 'Archive'}
                </button>
                <button
                  onClick={() => setConfirmPrompt({
                    title: `Delete "${project.campaign_name}"?`,
                    body: 'The campaign and everything recorded against it — daily performance, notes and reports — stop being visible anywhere. This cannot be undone; archive it instead if you only want it out of the way.',
                    confirmLabel: 'Delete campaign',
                    danger: true,
                    onConfirm: () => { void onDelete() },
                  })}
                  disabled={deleting}
                  title="Delete campaign"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-500/20 dark:text-red-400 disabled:opacity-50 transition-colors"
                >
                  {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {showSettings && (
        <section aria-label="Sync and connection" className="rounded-xl border border-border bg-card p-4">
          <IntegrationsTab project={project} canEdit={perms.edit} onChange={() => router.refresh()} />
        </section>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 border-b border-border" role="tablist">
        {tabs.map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key ? 'border-pink-500 text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <OverviewTab
            project={project} agg={agg} remaining={remaining} health={health} result={result}
            allocations={allocations} wallet={wallet} allocSupported={allocSupported}
            campaignTask={tasks[0] ?? null} invoice={invoice} perms={perms}
          />
          {/* Activity = notes + the full event timeline (formerly two tabs). */}
          <section id="activity" aria-labelledby="activity-heading" className="space-y-3 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-2">
              <h2 id="activity-heading" className="text-sm font-semibold">Activity</h2>
              <button onClick={() => setShowTimeline(v => !v)} aria-expanded={showTimeline}
                className="text-xs text-muted-foreground hover:text-foreground">
                {showTimeline ? 'Hide full timeline' : 'Show full timeline'}
              </button>
            </div>
            <NotesTab projectId={project.id} notes={notes} canEdit={perms.edit} onChange={() => router.refresh()} />
            {showTimeline && <TimelineTab scope={{ projectId: project.id }} />}
          </section>
        </>
      )}
      {tab === 'performance' && (
        <><CreativePerformance projectId={project.id} /><CampaignReviewTools projectId={project.id} /><DailyTab projectId={project.id} campaignType={project.campaign_type} metrics={metrics} perms={perms} onChange={() => router.refresh()} /></>
      )}
      {tab === 'funds' && canSeeFunds && (
        <BudgetTab
          project={project} invoice={invoice} canManage={perms.manageBudget} onChange={() => router.refresh()}
          services={services} servicePricing={servicePricing}
          allocations={allocations} wallet={wallet} allocSupported={allocSupported}
          reportedSpend={agg.spend} campaignTask={tasks[0] ?? null}
          viewBilling={perms.viewBilling}
        />
      )}
      {tab === 'reports' && (
        <ProjectReportsTab projectId={project.id} clientId={project.client_id ?? ''} canEdit={perms.edit}
          composerProjects={clientCampaigns} preferences={reportPreferences} preferencesSupported={reportPreferencesSupported} />
      )}
      {confirmPrompt && (
        <ConfirmDialog
          title={confirmPrompt.title}
          body={confirmPrompt.body}
          confirmLabel={confirmPrompt.confirmLabel}
          danger={confirmPrompt.danger}
          onConfirm={() => { const fn = confirmPrompt.onConfirm; setConfirmPrompt(null); fn() }}
          onCancel={() => setConfirmPrompt(null)}
        />
      )}
    </div>
  )
}

// ─── Overview ────────────────────────────────────────────────────────────────

function OverviewTab({ project, agg, remaining, health, result, allocations = [], wallet = null, allocSupported = false, campaignTask = null, invoice = null, perms }: {
  project: Project
  agg: ReturnType<typeof aggregateMetrics>
  remaining: number | null
  health: HealthScoreResult
  result: { definition: ResultDefinition; count: number | null; cost: number | null }
  allocations?: CampaignAllocation[]
  wallet?: WalletSummaryView | null
  allocSupported?: boolean
  campaignTask?: Props['tasks'][number] | null
  invoice?: Props['invoice']
  perms: Props['perms']
}) {
  const router = useRouter()
  void remaining // superseded by the GST-aware remaining below
  const [editingDates, setEditingDates] = useState(false)
  const [startDateInput, setStartDateInput] = useState(project.start_date ?? '')
  const [endDateInput, setEndDateInput] = useState(project.end_date ?? '')
  const [savingDates, setSavingDates] = useState(false)

  const [objective, setObjective] = useState(project.campaign_type ?? '')
  const [savingObjective, setSavingObjective] = useState(false)
  const [objectiveError, setObjectiveError] = useState<string | null>(null)

  // Saves on change, like the status select. The objective decides what
  // reports count as this campaign's results (leads, conversations, purchases…).
  async function saveObjective(next: string) {
    const previous = objective
    setObjective(next); setSavingObjective(true); setObjectiveError(null)
    const res = await updateAdProject(project.id, { campaignType: next || null })
    setSavingObjective(false)
    if (res.ok) router.refresh()
    else { setObjective(previous); setObjectiveError(res.error ?? 'Could not save the objective.') }
  }

  async function saveDates() {
    setSavingDates(true)
    const res = await updateAdProject(project.id, {
      startDate: startDateInput || null,
      endDate: endDateInput || null,
    })
    setSavingDates(false)
    if (res.ok) { setEditingDates(false); router.refresh() }
  }

  const allocated = round2(allocations.reduce((s, a) => s + Number(a.amount_inr || 0), 0))
  const hasAllocations = allocations.length > 0
  const basis = allocated
  const spend = agg.spend || 0
  const spendGross = project.actual_spend_inr ?? spendWithGst(spend)              // actual money consumed (incl. 18% GST)
  const serviceCharge = computeServiceCharge(spendGross, project.service_charge_type, Number(project.service_charge_value || 0))

  // Composed per money layer. Allocations/budget/spend are the campaign's
  // working numbers — every viewer gets them. Service charge is billing
  // (view_billing); wallet balance is the wallet layer (view_financials).
  // The server sends none of the gated data anyway — this skips empty tiles.
  //
  // 'GST 18%' and 'Spend (Meta, excl. GST)' tiles were dropped: both are
  // recomputable from 'Spend incl. GST' and repeat in the Budget tab summary.
  void spend
  const financials: [string, string][] = [
    ['Allocated (wallet)', hasAllocations ? inr(allocated, 2) : '—'],
    ['Budget (estimated)', inr(project.ad_budget_amount)],
    ['Spend incl. GST 18%', inr(spendGross, 2)],
    ['Allocation remaining (incl. GST)', inr(round2(basis - spendGross), 2)],
    ...(perms.viewBilling ? [
      ['Service charge (billing)', `${inr(serviceCharge, 2)}${project.service_charge_type === 'percent' ? ` (${project.service_charge_value}%)` : ''}`] as [string, string],
    ] : []),
    ...(perms.viewFinancials ? [
      ['Unallocated wallet', allocSupported && wallet ? inr(wallet.balanceInr, 2) : '—'] as [string, string],
    ] : []),
  ]

  // The objective's result leads the tiles. A count the objective already
  // shows elsewhere (Leads, Clicks) is not repeated; its cost always is.
  // Revenue/ROAS/CPC/CTR read "Not tracked"/"—" when they can't be measured,
  // never ₹0 / 0×.
  const def = result.definition
  const resultTiles: [string, string][] = def.metric ? [
    ...(def.metric === 'leads' || def.metric === 'clicks' ? [] : [[def.label, num(result.count)] as [string, string]]),
    [def.costLabel, inr(result.cost, 2)],
  ] : []
  const kpis: [string, string][] = [
    ...resultTiles,
    ['Revenue', agg.revenue > 0 ? inr(agg.revenue) : 'Not tracked'],
    ['ROAS', agg.revenue > 0 ? `${round2(agg.roas)}×` : '—'],
    ['CTR', agg.impressions > 0 ? `${round2(agg.ctr)}%` : '—'],
    ['CPC', agg.clicks > 0 ? inr(agg.cpc, 2) : '—'],
    ['Clicks', num(agg.clicks)],
    ['Impressions', num(agg.impressions)],
    ['Leads', num(agg.leads)],
    ['Conversions', num(agg.conversions)],
    ['Days reported', String(agg.days)],
  ]

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Campaign health</div>
          {health.insufficientData ? (
            <div className="text-2xl font-bold">Not graded</div>
          ) : (
            <div className="text-2xl font-bold">{health.score}<span className="text-base font-normal text-muted-foreground">/100 · Grade {health.grade}</span></div>
          )}
          {/* Why: the first reason that isn't the generic "not enough data". */}
          <div className="text-xs text-muted-foreground mt-0.5" title={health.explanations.join('\n')}>
            {health.explanations.find(e => !e.startsWith('Not enough data')) ?? healthLabel(health)}
          </div>
          {!def.metric && def.unavailableReason && (
            <div className="text-xs text-muted-foreground">{def.unavailableReason}</div>
          )}
        </div>
        <div className="flex flex-col items-start gap-1.5 text-left text-xs text-muted-foreground sm:items-end sm:text-right">
          <label className="inline-flex items-center gap-1.5" title="Decides what reports count as this campaign's results">
            <span>Objective</span>
            {perms.edit ? (
              <select
                value={objective}
                onChange={e => void saveObjective(e.target.value)}
                disabled={savingObjective}
                aria-label="Campaign objective"
                className="rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground disabled:opacity-50"
              >
                <option value="">Not set</option>
                {CIRQLE_CAMPAIGN_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            ) : (
              <span className="text-foreground">{CIRQLE_CAMPAIGN_TYPES.find(t => t.value === objective)?.label ?? 'Not set'}</span>
            )}
            {savingObjective && <Loader2 className="h-3 w-3 animate-spin" />}
          </label>
          {objectiveError && <span role="alert" className="text-red-500">{objectiveError}</span>}
          {editingDates ? (
            <div className="flex items-center gap-1.5">
              <input type="date" value={startDateInput} onChange={e => setStartDateInput(e.target.value)}
                className="rounded border border-border bg-background px-1.5 py-0.5 text-xs" />
              <span>→</span>
              <input type="date" value={endDateInput} onChange={e => setEndDateInput(e.target.value)}
                className="rounded border border-border bg-background px-1.5 py-0.5 text-xs" />
              <button onClick={saveDates} disabled={savingDates}
                className="rounded bg-pink-500 px-2 py-0.5 text-xs font-medium text-white hover:bg-pink-600 disabled:opacity-50">
                {savingDates ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
              </button>
              <button onClick={() => {
                setStartDateInput(project.start_date ?? ''); setEndDateInput(project.end_date ?? ''); setEditingDates(false)
              }} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
            </div>
          ) : (
            <button
              onClick={() => perms.edit && setEditingDates(true)}
              disabled={!perms.edit}
              className={`inline-flex items-center gap-1 ${perms.edit ? 'hover:text-foreground cursor-pointer' : 'cursor-default'}`}
              title={perms.edit ? 'Edit campaign dates' : undefined}
            >
              <Calendar className="h-3 w-3" />
              {project.start_date || '—'} → {project.end_date || '—'}
            </button>
          )}
        </div>
      </div>

      {/* Financials: wallet allocation, GST-aware spend, billing */}
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          {perms.viewFinancials || perms.viewBilling ? 'Financials' : 'Budget & Spend'}
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {financials.map(([k, v]) => (
            <div key={k} className="rounded-lg border border-border bg-card p-3 min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</div>
              <div className="text-lg font-semibold tabular-nums truncate" title={v}>{v}</div>
            </div>
          ))}
        </div>
        {perms.viewBilling && !hasAllocations && (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            No wallet funds allocated yet — Service charge billing requires funds to be allocated in the Budget tab.
          </p>
        )}
      </div>

      {/* Work + billing status */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {campaignTask ? (
          <Link href={`/dashboard/tasks?focus=${campaignTask.id}`}
            className="flex items-center justify-between rounded-lg border border-border bg-card p-3 hover:bg-secondary/50">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Campaign task</div>
              <div className="text-sm font-medium truncate">#{campaignTask.task_number ?? '—'} {campaignTask.title}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {perms.viewBilling
                  ? <>Billing {inr(campaignTask.billing_amount, 2)} · work split via Contributions</>
                  : <>Work split via Contributions</>}
              </div>
            </div>
            <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold capitalize">{campaignTask.status}</span>
          </Link>
        ) : (
          <div className="rounded-lg border border-dashed border-border bg-card p-3 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">No campaign task linked.</span>
            {perms.edit && (
              <button
                onClick={async (e) => {
                  const btn = e.currentTarget
                  btn.disabled = true
                  const originalText = btn.textContent
                  btn.textContent = 'Creating...'
                  const res = await generateTaskForProject(project.id)
                  if (!res.ok) {
                    alert(res.error)
                    btn.disabled = false
                    btn.textContent = originalText
                  } else {
                    router.refresh()
                  }
                }}
                className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
              >
                Create Task
              </button>
            )}
          </div>
        )}
        {perms.viewBilling && (invoice ? (
          <Link href={`/dashboard/invoices?focus=${invoice.id}`}
            className="flex items-center justify-between rounded-lg border border-border bg-card p-3 hover:bg-secondary/50">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Invoice</div>
              <div className="text-sm font-medium truncate">{invoice.invoice_number}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{inr(invoice.total_amount, 2)} · auto-synced with billing</div>
            </div>
            <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold capitalize">{invoice.status}</span>
          </Link>
        ) : (
          <div className="rounded-lg border border-dashed border-border bg-card p-3 text-xs text-muted-foreground">
            No invoice yet — create one from the Budget tab.
          </div>
        ))}
      </div>

      {/* Performance (platform-reported) */}
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Performance</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {kpis.map(([k, v]) => (
            <div key={k} className="rounded-lg border border-border bg-card p-3 min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</div>
              <div className="text-lg font-semibold tabular-nums truncate" title={v}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      {project.objective && (
        <div className="rounded-lg border border-border bg-card p-3 text-sm">
          <span className="text-muted-foreground">Objective: </span>{project.objective}
        </div>
      )}
    </div>
  )
}

// ─── Daily performance ───────────────────────────────────────────────────────

const EMPTY_ROW = {
  metricDate: todayISO(),
  spend: '', reach: '', impressions: '', clicks: '', conversions: '',
  leads: '', messages: '', purchases: '', revenue: '', videoViews: '', notes: '',
}

function DailyTab({ projectId, campaignType, metrics, perms, onChange }: {
  projectId: string
  campaignType: string | null
  metrics: AdDailyMetricRow[]
  perms: Props['perms']
  onChange: () => void
}) {
  const [form, setForm] = useState({ ...EMPTY_ROW })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))
  const n = (v: string) => (v === '' ? null : Number(v))

  async function add() {
    if (!form.metricDate) { setError('Pick a date.'); return }
    setBusy(true); setError(null)
    const res = await upsertDailyMetric(projectId, {
      metricDate: form.metricDate,
      spend: n(form.spend), reach: n(form.reach), impressions: n(form.impressions),
      clicks: n(form.clicks), conversions: n(form.conversions), leads: n(form.leads),
      messages: n(form.messages), purchases: n(form.purchases), revenue: n(form.revenue),
      videoViews: n(form.videoViews), notes: form.notes || null,
    })
    setBusy(false)
    if (res.ok) { setForm({ ...EMPTY_ROW }); onChange() }
    else setError(res.error || 'Could not save.')
  }

  const inputCls = 'w-full rounded border border-border bg-card px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-pink-500/40'

  return (
    <div className="space-y-4">
      {perms.enterMetrics && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-sm font-semibold mb-3">Add / update a day</div>
          {error && <div className="mb-2 text-xs text-red-600">{error}</div>}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
            <LabeledInput label="Date" type="date" value={form.metricDate} onChange={v => set('metricDate', v)} cls={inputCls} />
            <LabeledInput label="Spend" value={form.spend} onChange={v => set('spend', v)} cls={inputCls} />
            <LabeledInput label="Reach" value={form.reach} onChange={v => set('reach', v)} cls={inputCls} />
            <LabeledInput label="Impr." value={form.impressions} onChange={v => set('impressions', v)} cls={inputCls} />
            <LabeledInput label="Clicks" value={form.clicks} onChange={v => set('clicks', v)} cls={inputCls} />
            <LabeledInput label="Convs" value={form.conversions} onChange={v => set('conversions', v)} cls={inputCls} />
            <LabeledInput label="Leads" value={form.leads} onChange={v => set('leads', v)} cls={inputCls} />
            <LabeledInput label="Messages" value={form.messages} onChange={v => set('messages', v)} cls={inputCls} />
            <LabeledInput label="Purchases" value={form.purchases} onChange={v => set('purchases', v)} cls={inputCls} />
            <LabeledInput label="Revenue" value={form.revenue} onChange={v => set('revenue', v)} cls={inputCls} />
            <LabeledInput label="Video views" value={form.videoViews} onChange={v => set('videoViews', v)} cls={inputCls} />
            <LabeledInput label="Notes" value={form.notes} onChange={v => set('notes', v)} cls={inputCls} />
          </div>
          <div className="mt-3 flex justify-end">
            <button onClick={add} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 hover:opacity-90">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Save day
            </button>
          </div>
        </div>
      )}

      {metrics.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No daily entries yet. Copy the day&apos;s numbers from Ads Manager above.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-xs">
            <thead className="bg-secondary/60 text-muted-foreground">
              <tr>
                {['Date', 'Spend', 'Impr.', 'Clicks', 'CTR', 'CPC', 'CPM', 'Leads', 'Conv.', 'Revenue', 'ROAS', 'Status', 'Sync State', ''].map(h => (
                  <th key={h} className="px-2 py-2 text-left font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metrics.map(m => {
                const d = deriveMetrics(m, campaignType)
                return (
                  <tr key={m.id} className="border-t border-border">
                    <td className="px-2 py-1.5 whitespace-nowrap">{m.metric_date}</td>
                    <td className="px-2 py-1.5 tabular-nums">{inr(d.spend, 2)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{num(d.impressions)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{num(d.clicks)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{d.ctr != null ? `${d.ctr}%` : '—'}</td>
                    <td className="px-2 py-1.5 tabular-nums">{inr(d.cpc, 2)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{inr(d.cpm, 2)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{num(m.leads)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{num(m.conversions)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{inr(d.revenue, 2)}</td>
                    <td className="px-2 py-1.5 tabular-nums">{d.roas != null ? `${d.roas}×` : '—'}</td>
                    <td className="px-2 py-1.5">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${m.status === 'approved' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-amber-500/15 text-amber-600'}`}>
                        {m.status}
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                        m.sync_state === 'locked' ? 'bg-purple-500/15 text-purple-600' :
                        m.sync_state === 'imported' ? 'bg-blue-500/15 text-blue-600' :
                        'bg-slate-500/15 text-slate-600'
                      }`}>
                        {m.sync_state || 'manual'}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap flex gap-2">
                      {perms.approveMetrics && m.status !== 'approved' && (
                        <button title="Approve" onClick={async () => { await approveDailyMetric(m.id, projectId); onChange() }} className="mr-1 text-emerald-600 hover:text-emerald-700">
                          <Check className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {perms.enterMetrics && m.sync_state !== 'locked' && (
                        <button title="Lock" onClick={async () => { await setMetricSyncState(m.id, projectId, 'locked'); onChange() }} className="text-purple-600 hover:text-purple-700">
                          Lock
                        </button>
                      )}
                      {perms.enterMetrics && m.sync_state === 'locked' && (
                        <button title="Unlock" onClick={async () => { await setMetricSyncState(m.id, projectId, 'manual'); onChange() }} className="text-slate-600 hover:text-slate-700">
                          Unlock
                        </button>
                      )}
                      {perms.enterMetrics && (
                        <button title="Delete" onClick={async () => { await deleteDailyMetric(m.id, projectId); onChange() }} className="text-red-500 hover:text-red-600">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function LabeledInput({ label, value, onChange, cls, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; cls: string; type?: string
}) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">{label}</span>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} className={cls} inputMode={type === 'date' ? undefined : 'decimal'} />
    </label>
  )
}

// ─── Budget ──────────────────────────────────────────────────────────────────

/** Map a stored day count back to a duration preset for re-editing. */
function presetFromDays(days?: number | null): string {
  if (days === 7 || days === 14 || days === 30) return String(days)
  return days != null && days > 0 ? 'custom' : '7'
}

function BudgetTab({ project, invoice, canManage, onChange, services = [], servicePricing = [], allocations = [], wallet = null, allocSupported = false, reportedSpend = 0, campaignTask = null, viewBilling = false }: {
  project: Project
  invoice: Props['invoice']
  canManage: boolean
  onChange: () => void
  services?: Props['services']
  servicePricing?: Props['servicePricing']
  allocations?: CampaignAllocation[]
  wallet?: WalletSummaryView | null
  allocSupported?: boolean
  reportedSpend?: number
  campaignTask?: Props['tasks'][number] | null
  viewBilling?: boolean
}) {
  const derivedPricing = useMemo(() => {
    if (!project.service_id) return null
    const svc = services.find(s => s.id === project.service_id)
    if (!svc) return null
    const override = servicePricing.find(p => p.service_id === project.service_id && p.client_id === project.client_id)
    const price = override?.price ?? svc.default_price
    if (price == null) return null
    return {
      serviceName: svc.name,
      isPercent: svc.pricing_type === 'percentage_of_spend',
      value: Number(price),
    }
  }, [project.service_id, project.client_id, services, servicePricing])

  const [budget, setBudget] = useState<BudgetValue>(() => {
    const isMatchesDb = derivedPricing
      && project.service_charge_type === (derivedPricing.isPercent ? 'percent' : 'fixed')
      && Number(project.service_charge_value) === derivedPricing.value

    return emptyBudget({
      mode: project.budget_input_mode === 'daily' ? 'daily' : 'total',
      adBudget: project.ad_budget_amount != null ? String(project.ad_budget_amount) : '',
      dailyBudget: project.daily_budget != null ? String(project.daily_budget) : '',
      durationPreset: presetFromDays(project.budget_days),
      currency: project.ad_budget_currency || 'INR',
      scType: (project.service_charge_type as 'fixed' | 'percent') || 'fixed',
      scValue: project.service_charge_value != null ? String(project.service_charge_value) : '',
      taxPercent: project.tax_percent != null ? String(project.tax_percent) : '',
      overrideServiceCharge: !isMatchesDb,
    })
  })
  const [busy, setBusy] = useState(false)
  const [invBusy, setInvBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function save() {
    const { adSpend, days } = resolveBudget(budget, project.start_date, project.end_date)
    if (budget.mode === 'daily' && (Number(budget.dailyBudget) || 0) <= 0) {
      setMsg('Enter a daily budget amount before saving — it is currently empty, which would zero out the total.')
      return
    }
    if (budget.mode === 'daily' && days <= 0) {
      setMsg('No days to budget for — pick a duration or set the campaign start/end date above.')
      return
    }
    setBusy(true); setMsg(null)
    const res = await saveAdBudget(project.id, {
      adBudget: adSpend,
      adBudgetCurrency: budget.currency,
      budgetInputMode: budget.mode,
      dailyBudget: budget.mode === 'daily' ? Number(budget.dailyBudget) || 0 : null,
      budgetDays: budget.mode === 'daily' ? days : null,
      serviceChargeType: budget.scType,
      serviceChargeValue: Number(budget.scValue) || 0,
      taxPercent: Number(budget.taxPercent) || 0,
    })
    setBusy(false)
    if (res.ok) { setMsg('Budget saved. Any linked draft invoice was resynced.'); onChange() }
    else setMsg(res.error || 'Could not save.')
  }

  async function makeInvoice() {
    setInvBusy(true); setMsg(null)
    const res = await createInvoiceForProject(project.id)
    setInvBusy(false)
    if (res.ok) { setMsg('Invoice ready.'); onChange() }
    else setMsg(res.error || 'Could not create invoice.')
  }

  return (
    <div className="space-y-4">
      {/* Budget + service-charge configuration and invoicing are billing
          (view_billing) — the server sends null charge fields without it,
          so rendering the form would show misleading empty terms. */}
      {viewBilling && (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <BudgetFields
            value={budget}
            onChange={p => setBudget(b => {
              const next = { ...b, ...p }
              if (p.overrideServiceCharge === false && derivedPricing) {
                next.scType = derivedPricing.isPercent ? 'percent' : 'fixed'
                next.scValue = String(derivedPricing.value)
              }
              return next
            })}
            startDate={project.start_date}
            endDate={project.end_date}
            disabled={!canManage}
            derivedPricing={derivedPricing}
          />

          {msg && <div className="text-xs text-muted-foreground">{msg}</div>}

          {canManage && (
            <div className="flex flex-wrap justify-end gap-2">
              <button onClick={save} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save budget
              </button>
              <button onClick={makeInvoice} disabled={invBusy} className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-3 py-2 text-sm font-medium text-white disabled:opacity-50 hover:opacity-90">
                {invBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                {invoice ? 'Update invoice' : 'Create invoice'}
              </button>
            </div>
          )}
        </div>
      )}

      <FundAllocationCard
        project={project}
        allocations={allocations}
        wallet={wallet}
        supported={allocSupported}
        reportedSpend={reportedSpend}
        campaignTask={campaignTask}
        canManage={canManage}
        viewBilling={viewBilling}
        onChange={onChange}
      />

      {viewBilling && invoice && (
        <Link href={`/dashboard/invoices?focus=${invoice.id}`} className="flex items-center justify-between rounded-xl border border-border bg-card p-4 hover:bg-secondary/50">
          <div className="text-sm">
            <div className="font-medium">{invoice.invoice_number}</div>
            <div className="text-xs text-muted-foreground">Agency Services + a separate Advertising Spend section · {invoice.status}</div>
          </div>
          <span className="inline-flex items-center gap-1 text-sm">{inr(invoice.total_amount, 2)} <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" /></span>
        </Link>
      )}
    </div>
  )
}

// ─── Fund allocation (client wallet → campaign billing) ─────────────────────

function FundAllocationCard({ project, allocations, wallet, supported, reportedSpend, campaignTask, canManage, viewBilling = false, onChange }: {
  project: Project
  allocations: CampaignAllocation[]
  wallet: WalletSummaryView | null
  supported: boolean
  reportedSpend: number
  campaignTask: Props['tasks'][number] | null
  canManage: boolean
  viewBilling?: boolean
  onChange: () => void
}) {
  const { dn } = usePrivacy()
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState<string | null>(null) // 'add' | ledger row id
  const [err, setErr] = useState<string | null>(null)

  const allocatedTotal = round2(allocations.reduce((s, a) => s + Number(a.amount_inr || 0), 0))
  const hasAllocations = allocations.length > 0
  const basis = allocatedTotal
  // Company (internal) campaigns draw from the company wallet and are never
  // billed — no service charge applies.
  const isCompanyCampaign = !project.client_id && (project as any).scope === 'company'
  const walletEligible = Boolean(project.client_id) || isCompanyCampaign
  const spendGross = project.actual_spend_inr ?? spendWithGst(reportedSpend)
  const serviceCharge = isCompanyCampaign
    ? 0
    : computeServiceCharge(spendGross, project.service_charge_type, Number(project.service_charge_value || 0))
  const balance = wallet?.balanceInr ?? 0

  async function add() {
    setBusy('add'); setErr(null)
    const res = await allocateToCampaign(project.id, { amount: Number(amount) || 0 })
    setBusy(null)
    if (res.ok) { setAmount(''); onChange() }
    else setErr(res.error || 'Could not allocate.')
  }

  async function remove(id: string) {
    setBusy(id); setErr(null)
    const res = await removeWalletTransaction(id)
    setBusy(null)
    if (res.ok) onChange()
    else setErr(res.error || 'Could not remove.')
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">
            {isCompanyCampaign ? 'Campaign Funds (Company Wallet)' : 'Campaign Funds (Client Wallet)'}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isCompanyCampaign
              ? <>Internal campaign — funded from Cirqle&apos;s own wallet (GST-inclusive money actually paid). Never invoiced; the spend lands on the Company P&amp;L. Top up the company wallet from the Advertising dashboard.</>
              : <>Billing follows the funds allocated to this campaign from the client&apos;s wallet (GST-inclusive money actually
            paid). Platform-reported spend stays reporting-only. Top up the wallet from the Advertising dashboard.</>}
          </p>
        </div>
        {supported && wallet && (
          <div className="rounded-lg bg-secondary/60 px-3 py-1.5 text-xs">
            <span className="text-muted-foreground">{isCompanyCampaign ? 'Company' : (project.client?.name || 'Client')} wallet: </span>
            <span className={`font-semibold tabular-nums ${balance < 0 ? 'text-red-500' : ''}`}>{inr(balance, 2)}</span>
            <span className="text-muted-foreground"> available</span>
          </div>
        )}
      </div>

      {!supported && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          The wallet ledger needs a database migration. Apply <code>supabase/migrations/20260703140000_ad_wallet_ledger.sql</code> to enable this section.
        </div>
      )}

      {supported && !walletEligible && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Assign a client to this campaign to allocate wallet funds.
        </div>
      )}

      {supported && walletEligible && (
        <>
          {/* Allocation ledger for this campaign */}
          {allocations.length > 0 ? (
            <div className="divide-y divide-border rounded-lg border border-border">
              {allocations.map(a => (
                <div key={a.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="truncate">
                      Allocated from wallet
                      {a.notes ? <span className="text-muted-foreground"> — {a.notes}</span> : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(a.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                      {a.creator ? ` · ${dn(a.creator)}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="tabular-nums font-medium">{inr(a.amount_inr, 2)}</span>
                    {canManage && (
                      <button
                        onClick={() => remove(a.id)}
                        disabled={busy === a.id}
                        title="Reverse this allocation"
                        className="text-muted-foreground hover:text-red-500 disabled:opacity-50"
                      >
                        {busy === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No funds allocated yet — billing currently falls back to the estimated budget ({inr(project.ad_budget_amount, 2)}).
            </p>
          )}

          {/* Allocate from wallet */}
          {canManage && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-44">
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Amount (max {inr(Math.max(0, balance), 2)})
                </label>
                <input
                  type="number" min="0" step="0.01" value={amount}
                  onChange={e => setAmount(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm tabular-nums"
                />
              </div>
              <button
                onClick={add}
                disabled={busy === 'add' || !(Number(amount) > 0)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50"
              >
                {busy === 'add' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Allocate from wallet
              </button>
            </div>
          )}

          {err && <p className="text-xs text-red-500">{err}</p>}

          {/* GST-aware summary. The first row (allocation vs spend) is the
              working budget — every viewer. The billing row is view_billing. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1">
            <SummaryCell label="Allocated (paid, GST incl.)" value={inr(allocatedTotal, 2)} />
            <SummaryCell label="Spend incl. GST 18%" value={inr(spendGross, 2)} />
            <SummaryCell label="Unspent allocation" value={inr(round2(basis - spendGross), 2)} />
            {viewBilling && (
              <>
                <SummaryCell label="Billing basis" value={`${inr(basis, 2)}${hasAllocations ? '' : ' (estimated)'}`} />
                <SummaryCell
                  label="Service charge"
                  value={`${inr(serviceCharge, 2)}${project.service_charge_type === 'percent' ? ` (${project.service_charge_value}%)` : ''}`}
                />
                <SummaryCell label="Task billing (auto-updated)" value={campaignTask ? inr(campaignTask.billing_amount, 2) : '—'} />
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-secondary/50 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  )
}

// ─── Notes ───────────────────────────────────────────────────────────────────
// The inline ad_events timeline that used to sit beside the notes was removed:
// it duplicated the dedicated Timeline tab (the universal activity feed, which
// covers advertising events and strips finance categories server-side).

function NotesTab({ projectId, notes, canEdit, onChange }: {
  projectId: string; notes: Props['notes']; canEdit: boolean; onChange: () => void
}) {
  const { dn } = usePrivacy()
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  async function add() {
    if (!body.trim()) return
    setBusy(true)
    await addAdNote(projectId, body)
    setBusy(false); setBody(''); onChange()
  }
  return (
    <div className="max-w-2xl space-y-3">
      <div className="text-sm font-semibold">Notes</div>
      {canEdit && (
        <div className="flex gap-2">
          <input value={body} onChange={e => setBody(e.target.value)} placeholder="Add a note…"
            className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-pink-500/40"
            onKeyDown={e => { if (e.key === 'Enter') add() }} />
          <button onClick={add} disabled={busy} aria-label="Add note" className="rounded-lg gradient-bg px-3 py-2 text-sm font-medium text-white disabled:opacity-50 hover:opacity-90">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          </button>
        </div>
      )}
      {notes.length === 0 ? (
        <div className="text-sm text-muted-foreground">No notes yet.</div>
      ) : notes.map(nt => (
        <div key={nt.id} className="rounded-lg border border-border bg-card p-3 text-sm">
          <div>{nt.body}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {nt.author ? dn(nt.author) : 'Someone'} · {new Date(nt.created_at).toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Project Reports Tab ──────────────────────────────────────────────────────

interface ReportRow {
  id: string
  report_type: string
  template: string
  date_from: string
  date_to: string
  status: 'pending' | 'generating' | 'partial' | 'ready' | 'failed'
  error_message?: string | null
  generation_time_ms?: number | null
  pdf_url?: string | null
  xlsx_url?: string | null
  csv_url?: string | null
  image_url_portrait?: string | null
  created_at: string
}

function ProjectReportsTab({
  projectId,
  clientId,
  canEdit,
  composerProjects,
  preferences,
  preferencesSupported,
}: {
  projectId: string
  clientId: string
  canEdit: boolean
  composerProjects: ComposerProject[]
  preferences?: Record<string, ClientReportPreferences>
  preferencesSupported?: boolean
}) {
  const [reports, setReports] = useState<ReportRow[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  async function loadReports() {
    setLoadingList(true)
    try {
      const r = await fetch(`/api/advertising/reports?projectId=${projectId}&limit=10`)
      const j = await r.json()
      setReports(j.data ?? [])
    } finally {
      setLoadingList(false)
      setLoaded(true)
    }
  }

  // Load on first render
  if (!loaded && !loadingList) loadReports()

  const [deletingId, setDeletingId] = useState<string | null>(null)
  // In-app confirmation. NOT window.confirm: the desktop shell returns false
  // from it immediately without ever drawing a dialog, so Delete would sit
  // there dead with no error to explain it.
  const [deleteReportId, setDeleteReportId] = useState<string | null>(null)

  async function onDelete(reportId: string) {
    setDeletingId(reportId)
    setError(null)
    try {
      const res = await fetch(`/api/advertising/reports/${reportId}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? 'Failed to delete')
      setReports(prev => prev.filter(r => r.id !== reportId))
    } catch (err: any) {
      setError(err.message)
    } finally {
      setDeletingId(null)
    }
  }

  const statusIcon = (status: string) => ({
    pending:    <Clock className="h-3.5 w-3.5 text-muted-foreground" />,
    generating: <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />,
    partial:    <Clock className="h-4 w-4 text-amber-600" />,
    ready:      <CheckCircle className="h-3.5 w-3.5 text-green-500" />,
    failed:     <XCircle className="h-3.5 w-3.5 text-red-500" />,
  } as Record<string, React.ReactNode>)[status] ?? null

  return (
    <div className="space-y-6">
      {/* One composer everywhere (Reports hub, client workspace, here) —
          prefilled with this campaign; tick siblings for a client report. */}
      {canEdit && (
        <ReportComposer
          projects={composerProjects} initialClientId={clientId || undefined} initialProjectIds={[projectId]}
          preferences={preferences} preferencesSupported={preferencesSupported} canEdit={canEdit}
        />
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}

      {/* Report history */}
      <div>
        <h3 className="font-medium text-sm text-foreground mb-3">Report History</h3>
        {loadingList ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : reports.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reports generated yet.</p>
        ) : (
          <div className="space-y-2">
            {reports.map(r => (
              <div key={r.id} className="rounded-xl border border-border bg-card/50 p-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  {statusIcon(r.status)}
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-medium capitalize">{r.template}</span>
                      <span className="text-xs text-muted-foreground">{r.date_from} → {r.date_to}</span>
                    </div>
                    {(r.status === 'failed' || r.status === 'partial') && r.error_message && (
                      <p className="text-xs text-red-500 truncate">{r.error_message}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {r.pdf_url  && <a href={`/api/advertising/reports/${r.id}/download?format=pdf&redirect=1`}  target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"><Download className="h-3 w-3" />PDF</a>}
                  {r.xlsx_url && <a href={`/api/advertising/reports/${r.id}/download?format=xlsx&redirect=1`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"><Download className="h-3 w-3" />Excel</a>}
                  {r.csv_url  && <a href={`/api/advertising/reports/${r.id}/download?format=csv&redirect=1`}  target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"><Download className="h-3 w-3" />CSV</a>}
                  {r.image_url_portrait && <a href={`/api/advertising/reports/${r.id}/download?format=image_portrait&redirect=1`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"><Download className="h-3 w-3" />Image</a>}
                  {canEdit && (
                    <button
                      onClick={() => setDeleteReportId(r.id)}
                      disabled={deletingId === r.id}
                      title="Delete report"
                      className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-red-600 hover:border-red-300 disabled:opacity-50"
                    >
                      {deletingId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {deleteReportId && (
        <ConfirmDialog
          title="Delete this report?"
          body="The generated PDF and image files are removed from storage for good. Anyone you already sent a copy to keeps theirs; you can generate a fresh report for the same dates at any time."
          confirmLabel="Delete report"
          danger
          onConfirm={() => { const id = deleteReportId; setDeleteReportId(null); void onDelete(id) }}
          onCancel={() => setDeleteReportId(null)}
        />
      )}
    </div>
  )
}
