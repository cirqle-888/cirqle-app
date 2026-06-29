'use client'

/**
 * Advertising project detail — tabbed view over one campaign.
 * Overview · Daily Performance · Tasks · Budget · Notes.
 *
 * All money/metric math comes from the shared pure helpers (aggregateMetrics,
 * deriveMetrics, computeBudgetTotals, healthScore). Mutations go through the
 * guarded server actions; after each, router.refresh() re-pulls server data.
 */

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Megaphone, ArrowLeft, Loader2, Plus, Check, Trash2, FileText, ExternalLink,
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
  addAdTask, addAdNote, createInvoiceForProject, setMetricSyncState, softDeleteAdProject,
} from '../actions'
import { IntegrationsTab } from './integrations-tab'

type Project = AdProjectRow & { client?: { id: string; name: string; code: string } | null }
interface Props {
  project: Project
  metrics: AdDailyMetricRow[]
  tasks: { id: string; task_number: number | null; title: string; status: string; billing_amount: number }[]
  notes: { id: string; body: string; created_at: string; author?: { cqid?: string; name?: string } | null }[]
  events: { id: string; event_type: string; created_at: string; detail: any; actor?: { cqid?: string } | null }[]
  invoice: { id: string; invoice_number: string; status: string; total_amount: number } | null
  services?: { id: string; name: string; pricing_type: string | null; default_price: number | null }[]
  servicePricing?: { client_id: string; service_id: string; price: number }[]
  perms: { edit: boolean; manageBudget: boolean; enterMetrics: boolean; approveMetrics: boolean }
}

const inr = (v: number | null | undefined, dp = 0) =>
  v == null ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: dp })}`
const num = (v: number | null | undefined) =>
  v == null ? '—' : Number(v).toLocaleString('en-IN')

type Tab = 'overview' | 'daily' | 'tasks' | 'budget' | 'notes' | 'integrations'

export default function ProjectDetailClient({ project, metrics, tasks, notes, events, invoice, services, servicePricing, perms }: Props) {
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

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'daily', label: `Daily Performance${metrics.length ? ` (${metrics.length})` : ''}` },
    { key: 'tasks', label: `Tasks${tasks.length ? ` (${tasks.length})` : ''}` },
    { key: 'budget', label: 'Budget' },
    { key: 'notes', label: 'Notes' },
    { key: 'integrations', label: 'Integrations' },
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
              <button
                onClick={onDelete}
                disabled={deleting}
                title="Delete campaign"
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-500/20 dark:text-red-400 disabled:opacity-50 transition-colors"
              >
                {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Delete
              </button>
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
        <OverviewTab project={project} agg={agg} remaining={remaining} health={health} />
      )}
      {tab === 'daily' && (
        <DailyTab projectId={project.id} campaignType={project.campaign_type} metrics={metrics} perms={perms} onChange={() => router.refresh()} />
      )}
      {tab === 'tasks' && (
        <TasksTab projectId={project.id} clientId={project.client_id} tasks={tasks} canEdit={perms.edit} onChange={() => router.refresh()} />
      )}
      {tab === 'budget' && (
        <BudgetTab project={project} invoice={invoice} canManage={perms.manageBudget} onChange={() => router.refresh()} services={services} servicePricing={servicePricing} />
      )}
      {tab === 'notes' && (
        <NotesTab projectId={project.id} notes={notes} events={events} canEdit={perms.edit} onChange={() => router.refresh()} />
      )}
      {tab === 'integrations' && (
        <IntegrationsTab project={project} canEdit={perms.edit} onChange={() => router.refresh()} />
      )}
    </div>
  )
}

// ─── Overview ────────────────────────────────────────────────────────────────

function OverviewTab({ project, agg, remaining, health }: {
  project: Project
  agg: ReturnType<typeof aggregateMetrics>
  remaining: number | null
  health: ReturnType<typeof healthScore>
}) {
  const kpis: [string, string][] = [
    ['Budget', inr(project.ad_budget_amount)],
    ['Spent', inr(agg.spend)],
    ['Remaining', inr(remaining)],
    ['Revenue', inr(agg.revenue)],
    ['ROAS', agg.roas != null ? `${agg.roas}×` : '—'],
    ['CTR', agg.ctr != null ? `${agg.ctr}%` : '—'],
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
          {project.start_date || '—'} → {project.end_date || '—'}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {kpis.map(([k, v]) => (
          <div key={k} className="rounded-lg border border-border bg-card p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</div>
            <div className="text-lg font-semibold tabular-nums">{v}</div>
          </div>
        ))}
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

// ─── Tasks ───────────────────────────────────────────────────────────────────

function TasksTab({ projectId, clientId, tasks, canEdit, onChange }: {
  projectId: string; clientId: string | null
  tasks: Props['tasks']; canEdit: boolean; onChange: () => void
}) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  async function add() {
    if (!title.trim()) return
    setBusy(true)
    await addAdTask(projectId, { title, clientId })
    setBusy(false); setTitle(''); onChange()
  }
  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex gap-2">
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Add a campaign task…"
            className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-pink-500/40"
            onKeyDown={e => { if (e.key === 'Enter') add() }} />
          <button onClick={add} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-3 py-2 text-sm font-medium text-white disabled:opacity-50 hover:opacity-90">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
          </button>
        </div>
      )}
      {tasks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No tasks linked yet. These are normal Cirqle tasks — contributions &amp; payroll work on them as usual.
        </div>
      ) : (
        <div className="rounded-xl border border-border divide-y divide-border">
          {tasks.map(t => (
            <Link key={t.id} href={`/dashboard/tasks?focus=${t.id}`} className="flex items-center justify-between px-4 py-2.5 hover:bg-secondary/50">
              <span className="text-sm">
                <span className="text-muted-foreground mr-2">#{t.task_number ?? '—'}</span>{t.title}
              </span>
              <span className="text-xs text-muted-foreground">{t.status}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Budget ──────────────────────────────────────────────────────────────────

/** Map a stored day count back to a duration preset for re-editing. */
function presetFromDays(days?: number | null): string {
  if (days === 7 || days === 14 || days === 30) return String(days)
  return days != null && days > 0 ? 'custom' : '7'
}

function BudgetTab({ project, invoice, canManage, onChange, services = [], servicePricing = [] }: {
  project: Project
  invoice: Props['invoice']
  canManage: boolean
  onChange: () => void
  services?: Props['services']
  servicePricing?: Props['servicePricing']
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
    setBusy(true); setMsg(null)
    const { adSpend, days } = resolveBudget(budget, project.start_date, project.end_date)
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
