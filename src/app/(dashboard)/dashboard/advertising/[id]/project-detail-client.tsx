'use client'

/**
 * Advertising project detail — tabbed view over one campaign.
 * Overview · Daily Performance · Tasks · Budget · Notes.
 *
 * All money/metric math comes from the shared pure helpers (aggregateMetrics,
 * deriveMetrics, computeBudgetTotals, healthScore). Mutations go through the
 * guarded server actions; after each, router.refresh() re-pulls server data.
 */

import React, { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Megaphone, ArrowLeft, Loader2, Plus, Check, Trash2, FileText, ExternalLink, BarChart2,
  Download, Calendar, ChevronDown, CheckCircle, XCircle, Clock,
} from 'lucide-react'
import {
  AD_STATUS_CHIP, STATUS_LABEL, STATUSES, PLATFORM_LABEL, CAMPAIGN_TYPE_LABEL, adRefLabel,
  type AdProjectRow, type AdDailyMetricRow,
} from '@/lib/advertising/types'
import { deriveMetrics, remainingBudget } from '@/lib/advertising/metrics'
import { aggregateMetrics } from '@/lib/advertising/reporting'
import { healthScore } from '@/lib/advertising/health'
import BudgetFields, { emptyBudget, resolveBudget, type BudgetValue } from '../budget-fields'
import {
  updateAdStatus, saveAdBudget, upsertDailyMetric, approveDailyMetric, deleteDailyMetric,
  addAdNote, createInvoiceForProject, setMetricSyncState, softDeleteAdProject,
  allocateToCampaign, removeWalletTransaction, setAdProjectArchived, generateTaskForProject,
  updateAdProject,
} from '../actions'
import { computeServiceCharge, gstOnSpend, spendWithGst } from '@/lib/advertising/budget'
import { IntegrationsTab } from './integrations-tab'
import { Archive, ArchiveRestore } from 'lucide-react'
import { FavoriteToggle } from '@/components/ui/favorite-toggle'
import { TimelineTab } from '@/components/activity/timeline-tab'
import { DiscussButton } from '@/components/chat/discuss-button'

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
  clientId: string
  creditedInr: number
  allocatedInr: number
  balanceInr: number
}

interface Props {
  project: Project
  metrics: AdDailyMetricRow[]
  tasks: { id: string; task_number: number | null; title: string; status: string; billing_amount: number }[]
  notes: { id: string; body: string; created_at: string; author?: { cqid?: string; name?: string } | null }[]
  events: { id: string; event_type: string; created_at: string; detail: any; actor?: { cqid?: string } | null }[]
  invoice: { id: string; invoice_number: string; status: string; total_amount: number } | null
  services?: { id: string; name: string; pricing_type: string | null; default_price: number | null }[]
  servicePricing?: { client_id: string; service_id: string; price: number }[]
  allocations?: CampaignAllocation[]
  wallet?: WalletSummaryView | null
  allocSupported?: boolean
  perms: { edit: boolean; manageBudget: boolean; enterMetrics: boolean; approveMetrics: boolean }
}

const inr = (v: number | null | undefined, dp = 0) =>
  v == null ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: dp })}`
const num = (v: number | null | undefined) =>
  v == null ? '—' : Number(v).toLocaleString('en-IN')
const round2 = (v: number) => Math.round(v * 100) / 100

type Tab = 'overview' | 'daily' | 'budget' | 'notes' | 'integrations' | 'reports' | 'timeline'

export default function ProjectDetailClient({ project, metrics, tasks, notes, events, invoice, services, servicePricing, allocations = [], wallet = null, allocSupported = false, perms }: Props) {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('overview')
  const [status, setStatus] = useState(project.status)

  const agg = useMemo(() => aggregateMetrics(metrics), [metrics])
  const remaining = remainingBudget(project.ad_budget_amount, agg.spend)
  const health = useMemo(() => healthScore({
    adBudget: project.ad_budget_amount, totalSpend: agg.spend,
    startDate: project.start_date, endDate: project.end_date,
    roas: agg.roas, ctr: agg.ctr, status: project.status,
  }), [project, agg])

  const [deleting, setDeleting] = useState(false)
  const [archiving, setArchiving] = useState(false)

  async function onStatus(v: string) {
    setStatus(v)
    await updateAdStatus(project.id, v)
    router.refresh()
  }

  async function onDelete() {
    if (!confirm(`Delete "${project.campaign_name}"? This cannot be undone.`)) return
    setDeleting(true)
    const res = await softDeleteAdProject(project.id)
    if (res.ok) router.push('/dashboard/advertising')
    else { alert(res.error || 'Failed to delete.'); setDeleting(false) }
  }

  async function onToggleArchive() {
    const isArchived = !!project.archived_at
    if (!isArchived && !confirm(`Archive "${project.campaign_name}"? It will be hidden from active lists.`)) return
    setArchiving(true)
    const res = await setAdProjectArchived(project.id, !isArchived)
    setArchiving(false)
    if (res.ok) router.refresh()
    else alert(res.error || 'Failed to update archive status.')
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'daily', label: `Daily Performance${metrics.length ? ` (${metrics.length})` : ''}` },
    { key: 'budget', label: 'Budget' },
    { key: 'notes', label: 'Notes' },
    { key: 'integrations', label: 'Integrations' },
    { key: 'reports', label: 'Reports' },
    { key: 'timeline', label: 'Timeline' },
  ]

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
              <DiscussButton entityType="project" entityId={project.id} variant="icon" label="Discuss this campaign in chat" />
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {adRefLabel(project.id)} · {project.client?.name || 'No client'} · {PLATFORM_LABEL[project.platform] || project.platform}
              {project.campaign_type ? ` · ${CAMPAIGN_TYPE_LABEL[project.campaign_type] || project.campaign_type}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
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
                  onClick={onToggleArchive}
                  disabled={archiving}
                  title={project.archived_at ? 'Unarchive campaign' : 'Archive campaign'}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-50 transition-colors"
                >
                  {archiving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : project.archived_at ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
                  {project.archived_at ? 'Unarchive' : 'Archive'}
                </button>
                <button
                  onClick={onDelete}
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

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map(t => (
          <button
            key={t.key}
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
        <OverviewTab
          project={project} agg={agg} remaining={remaining} health={health}
          allocations={allocations} wallet={wallet} allocSupported={allocSupported}
          campaignTask={tasks[0] ?? null} invoice={invoice} perms={perms}
        />
      )}
      {tab === 'daily' && (
        <DailyTab projectId={project.id} campaignType={project.campaign_type} metrics={metrics} perms={perms} onChange={() => router.refresh()} />
      )}
      {tab === 'budget' && (
        <BudgetTab
          project={project} invoice={invoice} canManage={perms.manageBudget} onChange={() => router.refresh()}
          services={services} servicePricing={servicePricing}
          allocations={allocations} wallet={wallet} allocSupported={allocSupported}
          reportedSpend={agg.spend} campaignTask={tasks[0] ?? null}
        />
      )}
      {tab === 'notes' && (
        <NotesTab projectId={project.id} notes={notes} events={events} canEdit={perms.edit} onChange={() => router.refresh()} />
      )}
      {tab === 'integrations' && (
        <IntegrationsTab project={project} canEdit={perms.edit} onChange={() => router.refresh()} />
      )}
      {tab === 'reports' && (
        <ProjectReportsTab projectId={project.id} clientId={project.client_id ?? ''} canEdit={perms.edit} />
      )}
      {tab === 'timeline' && (
        <TimelineTab scope={{ projectId: project.id }} />
      )}
    </div>
  )
}

// ─── Overview ────────────────────────────────────────────────────────────────

function OverviewTab({ project, agg, remaining, health, allocations = [], wallet = null, allocSupported = false, campaignTask = null, invoice = null, perms }: {
  project: Project
  agg: ReturnType<typeof aggregateMetrics>
  remaining: number | null
  health: ReturnType<typeof healthScore>
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
  const spendGross = spendWithGst(spend)              // actual money consumed (incl. 18% GST)
  const serviceCharge = computeServiceCharge(basis, project.service_charge_type, Number(project.service_charge_value || 0))

  const financials: [string, string][] = [
    ['Allocated (wallet)', hasAllocations ? inr(allocated, 2) : '—'],
    ['Budget (estimated)', inr(project.ad_budget_amount)],
    ['Spend (Meta, excl. GST)', inr(spend, 2)],
    ['GST 18%', inr(gstOnSpend(spend), 2)],
    ['Spend incl. GST', inr(spendGross, 2)],
    ['Remaining (incl. GST)', inr(round2(basis - spendGross), 2)],
    ['Service charge (billing)', `${inr(serviceCharge, 2)}${project.service_charge_type === 'percent' ? ` (${project.service_charge_value}%)` : ''}`],
    ['Wallet balance', allocSupported && wallet ? inr(wallet.balanceInr, 2) : '—'],
  ]

  const kpis: [string, string][] = [
    ['Revenue', inr(agg.revenue)],
    ['ROAS', agg.roas != null ? `${round2(agg.roas)}×` : '—'],
    ['CTR', agg.ctr != null ? `${round2(agg.ctr)}%` : '—'],
    ['CPC', inr(agg.cpc, 2)],
    ['Clicks', num(agg.clicks)],
    ['Impressions', num(agg.impressions)],
    ['Leads', num(agg.leads)],
    ['Conversions', num(agg.conversions)],
    ['Days reported', String(agg.days)],
  ]

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-4 flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Campaign health</div>
          <div className="text-2xl font-bold">{health.score}<span className="text-base font-normal text-muted-foreground">/100 · {health.label}</span></div>
        </div>
        <div className="text-right text-xs text-muted-foreground">
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
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Financials</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {financials.map(([k, v]) => (
            <div key={k} className="rounded-lg border border-border bg-card p-3 min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</div>
              <div className="text-lg font-semibold tabular-nums truncate" title={v}>{v}</div>
            </div>
          ))}
        </div>
        {!hasAllocations && (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            No wallet funds allocated yet — Service charge billing requires funds to be allocated in the Budget tab.
          </p>
        )}
      </div>

      {/* Work + billing status */}
      <div className="grid gap-3 sm:grid-cols-2">
        {campaignTask ? (
          <Link href={`/dashboard/tasks?focus=${campaignTask.id}`}
            className="flex items-center justify-between rounded-lg border border-border bg-card p-3 hover:bg-secondary/50">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Campaign task</div>
              <div className="text-sm font-medium truncate">#{campaignTask.task_number ?? '—'} {campaignTask.title}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Billing {inr(campaignTask.billing_amount, 2)} · work split via Contributions
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
        {invoice ? (
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
        )}
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
  metricDate: new Date().toISOString().slice(0, 10),
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

function BudgetTab({ project, invoice, canManage, onChange, services = [], servicePricing = [], allocations = [], wallet = null, allocSupported = false, reportedSpend = 0, campaignTask = null }: {
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

      <FundAllocationCard
        project={project}
        allocations={allocations}
        wallet={wallet}
        supported={allocSupported}
        reportedSpend={reportedSpend}
        campaignTask={campaignTask}
        canManage={canManage}
        onChange={onChange}
      />

      {invoice && (
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

function FundAllocationCard({ project, allocations, wallet, supported, reportedSpend, campaignTask, canManage, onChange }: {
  project: Project
  allocations: CampaignAllocation[]
  wallet: WalletSummaryView | null
  supported: boolean
  reportedSpend: number
  campaignTask: Props['tasks'][number] | null
  canManage: boolean
  onChange: () => void
}) {
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState<string | null>(null) // 'add' | ledger row id
  const [err, setErr] = useState<string | null>(null)

  const allocatedTotal = round2(allocations.reduce((s, a) => s + Number(a.amount_inr || 0), 0))
  const hasAllocations = allocations.length > 0
  const basis = allocatedTotal
  const serviceCharge = computeServiceCharge(basis, project.service_charge_type, Number(project.service_charge_value || 0))
  const spendGross = spendWithGst(reportedSpend) // actual money consumed (incl. 18% GST)
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
          <h3 className="text-sm font-semibold">Campaign Funds (Client Wallet)</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Billing follows the funds allocated to this campaign from the client&apos;s wallet (GST-inclusive money actually
            paid). Platform-reported spend stays reporting-only. Top up the wallet from the Advertising dashboard.
          </p>
        </div>
        {supported && wallet && (
          <div className="rounded-lg bg-secondary/60 px-3 py-1.5 text-xs">
            <span className="text-muted-foreground">{project.client?.name || 'Client'} wallet: </span>
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

      {supported && !project.client_id && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Assign a client to this campaign to allocate wallet funds.
        </div>
      )}

      {supported && project.client_id && (
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
                      {a.creator?.name ? ` · ${a.creator.name}` : ''}
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

          {/* GST-aware billing summary */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1">
            <SummaryCell label="Allocated (paid, GST incl.)" value={inr(allocatedTotal, 2)} />
            <SummaryCell label="Spend incl. GST 18%" value={inr(spendGross, 2)} />
            <SummaryCell label="Unspent allocation" value={inr(round2(basis - spendGross), 2)} />
            <SummaryCell label="Billing basis" value={`${inr(basis, 2)}${hasAllocations ? '' : ' (estimated)'}`} />
            <SummaryCell
              label="Service charge"
              value={`${inr(serviceCharge, 2)}${project.service_charge_type === 'percent' ? ` (${project.service_charge_value}%)` : ''}`}
            />
            <SummaryCell label="Task billing (auto-updated)" value={campaignTask ? inr(campaignTask.billing_amount, 2) : '—'} />
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

// ─── Notes + timeline ────────────────────────────────────────────────────────

function NotesTab({ projectId, notes, events, canEdit, onChange }: {
  projectId: string; notes: Props['notes']; events: Props['events']; canEdit: boolean; onChange: () => void
}) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  async function add() {
    if (!body.trim()) return
    setBusy(true)
    await addAdNote(projectId, body)
    setBusy(false); setBody(''); onChange()
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3">
        <div className="text-sm font-semibold">Notes</div>
        {canEdit && (
          <div className="flex gap-2">
            <input value={body} onChange={e => setBody(e.target.value)} placeholder="Add a note…"
              className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-pink-500/40"
              onKeyDown={e => { if (e.key === 'Enter') add() }} />
            <button onClick={add} disabled={busy} className="rounded-lg gradient-bg px-3 py-2 text-sm font-medium text-white disabled:opacity-50 hover:opacity-90">
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
              {nt.author?.cqid || nt.author?.name || 'Someone'} · {new Date(nt.created_at).toLocaleString()}
            </div>
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <div className="text-sm font-semibold">Timeline</div>
        {events.length === 0 ? (
          <div className="text-sm text-muted-foreground">No activity yet.</div>
        ) : (
          <ol className="relative border-l border-border pl-4 space-y-3">
            {events.map(ev => (
              <li key={ev.id} className="text-sm">
                <span className="absolute -left-1.5 mt-1 h-3 w-3 rounded-full bg-pink-500/60 border-2 border-card" />
                <div className="font-medium capitalize">{ev.event_type.replace(/_/g, ' ')}</div>
                <div className="text-[11px] text-muted-foreground">
                  {ev.actor?.cqid ? `${ev.actor.cqid} · ` : ''}{new Date(ev.created_at).toLocaleString()}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
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
  status: 'pending' | 'generating' | 'ready' | 'failed'
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
}: {
  projectId: string
  clientId: string
  canEdit: boolean
}) {
  const [reports, setReports] = useState<ReportRow[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Form state
  const today = new Date().toISOString().slice(0, 10)
  const thirtyAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
  const [dateFrom, setDateFrom] = useState(thirtyAgo)
  const [dateTo, setDateTo] = useState(today)
  const [template, setTemplate] = useState('daily')
  const [formats, setFormats] = useState<string[]>(['pdf'])
  const [withComparison, setWithComparison] = useState(false)
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

  const toggleFormat = (f: string) =>
    setFormats(prev => prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f])

  async function onGenerate() {
    if (!clientId) { setError('Campaign has no associated client'); return }
    if (formats.length === 0) { setError('Select at least one format'); return }
    setGenerating(true); setError(null); setSuccess(null)
    try {
      const body: any = { projectId, clientId, reportType: 'custom', template, dateFrom, dateTo, formats }
      if (withComparison) {
        const from = new Date(dateFrom)
        const to   = new Date(dateTo)
        const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1
        const compTo = new Date(from); compTo.setDate(compTo.getDate() - 1)
        const compFrom = new Date(compTo); compFrom.setDate(compFrom.getDate() - days + 1)
        body.comparisonFrom = compFrom.toISOString().slice(0, 10)
        body.comparisonTo   = compTo.toISOString().slice(0, 10)
      }
      const res = await fetch('/api/advertising/reports/generate?sync=true', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      setSuccess('Report generated successfully.')
      loadReports()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setGenerating(false)
    }
  }

  const [deletingId, setDeletingId] = useState<string | null>(null)

  async function onDelete(reportId: string) {
    if (!confirm('Delete this report permanently? The PDF/image files will also be removed.')) return
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
    ready:      <CheckCircle className="h-3.5 w-3.5 text-green-500" />,
    failed:     <XCircle className="h-3.5 w-3.5 text-red-500" />,
  } as Record<string, React.ReactNode>)[status] ?? null

  return (
    <div className="space-y-6">
      {/* Generate form */}
      {canEdit && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <h3 className="font-medium text-sm text-foreground flex items-center gap-2">
            <BarChart2 className="h-4 w-4 text-primary" />
            Generate Report
          </h3>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">From</label>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm" />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">To</label>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm" />
            </div>
          </div>

          <div>
            <label className="block text-xs text-muted-foreground mb-1">Template</label>
            <select value={template} onChange={e => setTemplate(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm">
              <option value="daily">Daily Report (Meta / WhatsApp style)</option>
              <option value="performance">Performance Report</option>
              <option value="executive">Executive Summary</option>
              <option value="marketing">Marketing Performance</option>
              <option value="lead_gen">Lead Generation</option>
              <option value="ecommerce">E-commerce</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-muted-foreground mb-1">Formats</label>
            <div className="flex gap-2 flex-wrap">
              {['pdf', 'xlsx', 'csv', 'image_portrait'].map(f => (
                <button key={f} type="button" onClick={() => toggleFormat(f)}
                  className={['rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                    formats.includes(f) ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background text-muted-foreground'
                  ].join(' ')}>
                  {f}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={withComparison} onChange={e => setWithComparison(e.target.checked)}
              className="rounded border-border" />
            <span className="text-xs text-foreground">Compare with previous period</span>
          </label>

          {error && <p className="text-xs text-red-500">{error}</p>}
          {success && <p className="text-xs text-green-600">{success}</p>}

          <button onClick={onGenerate} disabled={generating}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            {generating ? 'Generating…' : 'Generate'}
          </button>
        </div>
      )}

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
                    {r.status === 'failed' && r.error_message && (
                      <p className="text-xs text-red-500 truncate">{r.error_message}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {r.pdf_url  && <a href={r.pdf_url}  target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"><Download className="h-3 w-3" />PDF</a>}
                  {r.xlsx_url && <a href={r.xlsx_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"><Download className="h-3 w-3" />Excel</a>}
                  {r.csv_url  && <a href={r.csv_url}  target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"><Download className="h-3 w-3" />CSV</a>}
                  {r.image_url_portrait && <a href={r.image_url_portrait} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"><Download className="h-3 w-3" />Image</a>}
                  {canEdit && (
                    <button
                      onClick={() => onDelete(r.id)}
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
    </div>
  )
}
