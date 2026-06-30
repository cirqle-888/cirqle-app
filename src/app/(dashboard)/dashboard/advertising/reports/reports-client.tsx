'use client'

/**
 * Reports Hub — Client Component
 *
 * Tabs: History | Generate | Schedules
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  FileText, Plus, Calendar, Download, Clock, CheckCircle, XCircle, Loader2,
  BarChart2, Megaphone, ChevronDown,
} from 'lucide-react'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Report {
  id: string
  project_id: string
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
  generated_at?: string | null
  project?: {
    id: string
    campaign_name: string
    platform: string
    client?: { id: string; name: string; code: string } | null
  } | null
}

interface Schedule {
  id: string
  project_id: string
  frequency: string
  report_type: string
  template: string
  formats: string[]
  is_active: boolean
  next_run_at?: string | null
  last_run_at?: string | null
  project?: {
    id: string
    campaign_name: string
    platform: string
    client?: { id: string; name: string; code: string } | null
  } | null
}

interface Project {
  id: string
  campaign_name: string
  platform: string
  client_id: string | null
  client?: { id: string; name: string; code: string } | null
}

interface Props {
  reports: Report[]
  schedules: Schedule[]
  projects: Project[]
  canEdit: boolean
}

type Tab = 'history' | 'generate' | 'schedules'

// ─── Main component ────────────────────────────────────────────────────────────

export default function ReportsClient({ reports, schedules, projects, canEdit }: Props) {
  const [tab, setTab] = useState<Tab>('history')

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'history',   label: 'Report History', count: reports.length },
    { key: 'generate',  label: 'Generate Report' },
    { key: 'schedules', label: 'Schedules', count: schedules.length },
  ]

  return (
    <div className="min-h-screen bg-background">
      {/* Page header */}
      <div className="border-b border-border bg-card/50 px-6 py-5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <FileText className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground">Reports</h1>
            <p className="text-sm text-muted-foreground">Generate, schedule, and download campaign reports</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="mt-4 flex gap-0 border-b border-border -mb-[1px]">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={[
                'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
                tab === t.key
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {t.label}
              {t.count !== undefined && t.count > 0 && (
                <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium">{t.count}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="p-6">
        {tab === 'history'   && <HistoryTab reports={reports} />}
        {tab === 'generate'  && <GenerateTab projects={projects} canEdit={canEdit} />}
        {tab === 'schedules' && <SchedulesTab schedules={schedules} projects={projects} canEdit={canEdit} />}
      </div>
    </div>
  )
}

// ─── History Tab ──────────────────────────────────────────────────────────────

function HistoryTab({ reports }: { reports: Report[] }) {
  if (reports.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <BarChart2 className="h-12 w-12 text-muted-foreground/40 mb-4" />
        <p className="text-muted-foreground">No reports generated yet.</p>
        <p className="text-sm text-muted-foreground/60 mt-1">Switch to Generate Report to create your first report.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {reports.map(r => (
        <ReportCard key={r.id} report={r} />
      ))}
    </div>
  )
}

function ReportCard({ report: r }: { report: Report }) {
  const statusIcon = {
    pending:    <Clock className="h-4 w-4 text-muted-foreground" />,
    generating: <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />,
    ready:      <CheckCircle className="h-4 w-4 text-green-500" />,
    failed:     <XCircle className="h-4 w-4 text-red-500" />,
  }[r.status]

  const formats: { key: string; url: string | null | undefined; label: string }[] = [
    { key: 'pdf',  url: r.pdf_url,           label: 'PDF' },
    { key: 'xlsx', url: r.xlsx_url,          label: 'Excel' },
    { key: 'csv',  url: r.csv_url,           label: 'CSV' },
    { key: 'img',  url: r.image_url_portrait, label: 'Image' },
  ].filter(f => f.url)

  return (
    <div className="rounded-xl border border-border bg-card p-4 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex-shrink-0">{statusIcon}</div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-foreground truncate max-w-[280px]">
              {r.project?.campaign_name ?? 'Unknown Campaign'}
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize">{r.template}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize">{r.report_type}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
            <span>{r.project?.client?.name ?? ''}</span>
            {r.project?.client?.name && <span>·</span>}
            <span>{r.date_from} → {r.date_to}</span>
            {r.generation_time_ms && <><span>·</span><span>{(r.generation_time_ms / 1000).toFixed(1)}s</span></>}
          </div>
          {r.status === 'failed' && r.error_message && (
            <p className="text-xs text-red-500 mt-0.5 truncate max-w-[400px]">{r.error_message}</p>
          )}
        </div>
      </div>

      {/* Download links */}
      {formats.length > 0 && (
        <div className="flex items-center gap-2 flex-shrink-0">
          {formats.map(f => (
            <a
              key={f.key}
              href={f.url!}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
            >
              <Download className="h-3 w-3" />
              {f.label}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Generate Tab ─────────────────────────────────────────────────────────────

// ─── Section toggles config ───────────────────────────────────────────────────

const SECTION_OPTIONS = [
  { key: 'executiveSummary',    label: 'Executive Summary',    desc: 'AI-written overview paragraph' },
  { key: 'dailyBreakdown',      label: 'Daily Breakdown',      desc: 'Date-by-date spend, reach, impressions table' },
  { key: 'campaignHealth',      label: 'Campaign Health Score', desc: 'Health grade & risk level' },
  { key: 'forecast',            label: 'Forecast',             desc: '7/30-day spend & leads forecast' },
  { key: 'aiInsights',          label: 'AI Insights',          desc: 'Key insights, risks & opportunities' },
  { key: 'budgetAnalysis',      label: 'Budget Analysis',      desc: 'Remaining budget & utilisation' },
  { key: 'recommendations',     label: 'Recommendations',      desc: 'AI-recommended actions' },
  { key: 'benchmarkComparison', label: 'Benchmark Comparison', desc: 'Performance vs industry benchmarks' },
] as const

type SectionKey = typeof SECTION_OPTIONS[number]['key']

// Default sections per template (must match template-engine.ts).
// Uses Record<string, boolean> to include kpiScorecard (always-on, not user-toggleable).
const TEMPLATE_DEFAULTS: Record<string, Record<string, boolean>> = {
  daily:       { kpiScorecard: true, dailyBreakdown: true, budgetAnalysis: true },
  performance: { executiveSummary: true, kpiScorecard: true, dailyBreakdown: true, campaignHealth: true, benchmarkComparison: true, forecast: true, aiInsights: true, budgetAnalysis: true, recommendations: true },
  executive:   { executiveSummary: true, kpiScorecard: true, campaignHealth: true, benchmarkComparison: true, forecast: true, aiInsights: true, budgetAnalysis: true, recommendations: true },
  marketing:   { executiveSummary: true, kpiScorecard: true, dailyBreakdown: true, campaignHealth: true, benchmarkComparison: true, forecast: true, aiInsights: true, recommendations: true },
  lead_gen:    { executiveSummary: true, kpiScorecard: true, dailyBreakdown: true, campaignHealth: true, benchmarkComparison: true, forecast: true, aiInsights: true, budgetAnalysis: true, recommendations: true },
  ecommerce:   { executiveSummary: true, kpiScorecard: true, dailyBreakdown: true, campaignHealth: true, benchmarkComparison: true, forecast: true, aiInsights: true, budgetAnalysis: true, recommendations: true },
  agency:      { executiveSummary: true, kpiScorecard: true, dailyBreakdown: true, campaignHealth: true, benchmarkComparison: true, forecast: true, aiInsights: true, budgetAnalysis: true, recommendations: true },
}

// ─── Generate Tab ─────────────────────────────────────────────────────────────

function GenerateTab({ projects, canEdit }: { projects: Project[]; canEdit: boolean }) {
  const router = useRouter()
  const [projectId, setProjectId] = useState('')
  const [reportType, setReportType] = useState('custom')
  const [template, setTemplate] = useState('daily')
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10)
  })
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10))
  const [formats, setFormats] = useState<string[]>(['pdf'])
  const [withComparison, setWithComparison] = useState(false)
  const [sections, setSections] = useState<Partial<Record<SectionKey, boolean>>>({})
  const [showSections, setShowSections] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const selectedProject = projects.find(p => p.id === projectId)

  // Effective section state = template defaults merged with user overrides
  const effectiveSections = { ...(TEMPLATE_DEFAULTS[template] ?? {}), ...sections }

  const toggleFormat = (f: string) =>
    setFormats(prev => prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f])

  const toggleSection = (key: SectionKey) =>
    setSections(prev => ({ ...prev, [key]: !effectiveSections[key] }))

  // When template changes, reset overrides so defaults take effect
  function onTemplateChange(t: string) {
    setTemplate(t)
    setSections({})
  }

  async function onGenerate() {
    if (!projectId) { setError('Select a campaign'); return }
    if (!dateFrom || !dateTo) { setError('Select a date range'); return }
    if (formats.length === 0) { setError('Select at least one format'); return }

    setLoading(true); setError(null); setSuccess(null)

    try {
      const body: any = {
        projectId,
        clientId: selectedProject?.client_id ?? '',
        reportType,
        template,
        dateFrom,
        dateTo,
        formats,
        sections: Object.keys(sections).length > 0 ? sections : undefined,
      }

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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')

      setSuccess('Report generated successfully.')
      router.refresh()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-xl space-y-5">
      <h2 className="font-semibold text-foreground">Generate a New Report</h2>

      {/* Campaign selector */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">Campaign</label>
        <select
          value={projectId}
          onChange={e => setProjectId(e.target.value)}
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm"
        >
          <option value="">Select a campaign…</option>
          {projects.map(p => (
            <option key={p.id} value={p.id}>
              {p.campaign_name} ({p.platform}) — {p.client?.name ?? ''}
            </option>
          ))}
        </select>
      </div>

      {/* Date range */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">From</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">To</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm" />
        </div>
      </div>

      {/* Template */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">Template</label>
        <select value={template} onChange={e => onTemplateChange(e.target.value)}
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <option value="daily">Daily Report — Cirqle style (Reach · Impressions · Clicks · Spend · CPR)</option>
          <option value="performance">Performance Report</option>
          <option value="executive">Executive Summary</option>
          <option value="marketing">Marketing Performance</option>
          <option value="lead_gen">Lead Generation</option>
          <option value="ecommerce">E-commerce</option>
          <option value="agency">Agency Report</option>
        </select>
      </div>

      {/* Section toggles */}
      <div>
        <button
          type="button"
          onClick={() => setShowSections(v => !v)}
          className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${showSections ? 'rotate-180' : ''}`} />
          Customise sections
        </button>

        {showSections && (
          <div className="mt-3 rounded-xl border border-border bg-card/50 p-4 space-y-2.5">
            {SECTION_OPTIONS.map(opt => (
              <label key={opt.key} className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!effectiveSections[opt.key]}
                  onChange={() => toggleSection(opt.key)}
                  className="mt-0.5 rounded border-border"
                />
                <div>
                  <div className="text-sm font-medium text-foreground">{opt.label}</div>
                  <div className="text-xs text-muted-foreground">{opt.desc}</div>
                </div>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Formats */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">Export Formats</label>
        <div className="flex flex-wrap gap-2">
          {[
            { key: 'pdf', label: 'PDF' },
            { key: 'xlsx', label: 'Excel' },
            { key: 'csv', label: 'CSV' },
            { key: 'image_portrait', label: 'Image (Portrait)' },
            { key: 'image_square', label: 'Image (Square)' },
          ].map(f => (
            <button
              key={f.key}
              type="button"
              onClick={() => toggleFormat(f.key)}
              className={[
                'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                formats.includes(f.key)
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-card text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Comparison period */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={withComparison} onChange={e => setWithComparison(e.target.checked)}
          className="rounded border-border" />
        <span className="text-sm text-foreground">Include comparison with previous period</span>
      </label>

      {error && <p className="text-sm text-red-500 bg-red-50 dark:bg-red-950/20 rounded-lg px-3 py-2">{error}</p>}
      {success && <p className="text-sm text-green-600 bg-green-50 dark:bg-green-950/20 rounded-lg px-3 py-2">{success}</p>}

      <button
        onClick={onGenerate}
        disabled={loading || !canEdit}
        className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        {loading ? 'Generating…' : 'Generate Report'}
      </button>
    </div>
  )
}

// ─── Schedules Tab ────────────────────────────────────────────────────────────

function SchedulesTab({ schedules, projects, canEdit }: { schedules: Schedule[]; projects: Project[]; canEdit: boolean }) {
  const router = useRouter()
  const [showCreate, setShowCreate] = useState(false)
  const [projectId, setProjectId] = useState('')
  const [frequency, setFrequency] = useState('weekly')
  const [template, setTemplate] = useState('performance')
  const [formats, setFormats] = useState<string[]>(['pdf'])
  const [recipients, setRecipients] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleFormat = (f: string) =>
    setFormats(prev => prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f])

  async function onCreateSchedule() {
    if (!projectId) { setError('Select a campaign'); return }
    const selectedProject = projects.find(p => p.id === projectId)
    if (!selectedProject?.client_id) { setError('Selected campaign has no client'); return }
    if (formats.length === 0) { setError('Select at least one format'); return }

    setLoading(true); setError(null)
    try {
      const recipientList = recipients
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(email => ({ email }))

      const res = await fetch('/api/advertising/reports/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          client_id: selectedProject.client_id,
          frequency,
          report_type: frequency,
          template,
          formats,
          include_comparison: true,
          recipients: recipientList,
          is_active: true,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')

      setShowCreate(false)
      router.refresh()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function onDeactivate(id: string) {
    await fetch(`/api/advertising/reports/schedules/${id}`, { method: 'DELETE' })
    router.refresh()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-foreground">Active Schedules</h2>
        {canEdit && (
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted/50 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            New Schedule
          </button>
        )}
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <h3 className="font-medium text-sm text-foreground">New Schedule</h3>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Campaign</label>
            <select value={projectId} onChange={e => setProjectId(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
              <option value="">Select…</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.campaign_name} — {p.client?.name ?? ''}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Frequency</label>
              <select value={frequency} onChange={e => setFrequency(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Template</label>
              <select value={template} onChange={e => setTemplate(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
                <option value="performance">Performance</option>
                <option value="executive">Executive</option>
                <option value="marketing">Marketing</option>
                <option value="lead_gen">Lead Gen</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Formats</label>
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

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Email Recipients (comma-separated)</label>
            <input type="text" value={recipients} onChange={e => setRecipients(e.target.value)}
              placeholder="client@example.com, team@example.com"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
          </div>

          {error && <p className="text-xs text-red-500">{error}</p>}

          <div className="flex gap-2">
            <button onClick={onCreateSchedule} disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Create
            </button>
            <button onClick={() => setShowCreate(false)}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Schedule list */}
      {schedules.length === 0 && !showCreate && (
        <div className="flex flex-col items-center py-12 text-center">
          <Calendar className="h-10 w-10 text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground">No active schedules.</p>
        </div>
      )}

      {schedules.map(s => (
        <div key={s.id} className="rounded-xl border border-border bg-card p-4 flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{s.project?.campaign_name ?? 'Unknown'}</span>
              <span className="rounded-full bg-green-500/10 text-green-600 dark:text-green-400 px-2 py-0.5 text-xs font-medium capitalize">{s.frequency}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize">{s.template}</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
              <span>{s.project?.client?.name ?? ''}</span>
              {s.next_run_at && <><span>·</span><span>Next: {new Date(s.next_run_at).toLocaleDateString()}</span></>}
              <span>·</span>
              <span className="capitalize">{(s.formats as string[]).join(', ')}</span>
            </div>
          </div>
          {canEdit && (
            <button onClick={() => onDeactivate(s.id)}
              className="text-xs text-muted-foreground hover:text-red-500 transition-colors border border-border rounded-lg px-2.5 py-1">
              Deactivate
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
