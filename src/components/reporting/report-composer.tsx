'use client'

/**
 * Report composer — the one way to prepare a report (plan Phase 4).
 *
 * Three steps: Client & campaigns → Period & purpose → Preview & share.
 * Used from the Reports hub, the client workspace and a campaign's Reports
 * tab (each passes a prefilled scope). Several campaigns of one client make
 * one client report; the server re-checks they share a client.
 *
 * Safety: editable previews persist an approval snapshot; generation goes through the queued,
 * idempotent flow (useReportSubmission → ReportProgress); e-mail is only
 * sent when "Email this report" is ticked for this send; a period with no
 * data at all needs an explicit "generate anyway".
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, Eye, FileText, Loader2, Save } from 'lucide-react'
import { ReportProgress } from './report-progress'
import { useReportSubmission } from './use-report-submission'
import WebReportViewer from '@/app/(dashboard)/dashboard/advertising/reports/components/WebReportViewer'
import { saveClientReportPreferences } from '@/app/(dashboard)/dashboard/advertising/reports/preference-actions'
import {
  REPORT_PRESETS, COMPOSER_PERIODS, composerRange, previousPeriod, presetByKey,
  type ComposerPeriod, type PresetKey,
} from '@/lib/reporting/presets'
import { REPORT_TEMPLATES, REPORT_FORMATS, isISODate, daySpan, MAX_RANGE_DAYS } from '@/lib/reporting/config'
import { describeDataQuality } from '@/lib/reporting/data-quality'
import type { ClientReportPreferences } from '@/lib/reporting/preferences'
import type { RenderData, ReportFormat, ReportTemplate } from '@/lib/reporting/types'
import { CAMPAIGN_TYPE_LABEL } from '@/lib/advertising/types'
import { todayISO } from '@/lib/utils/local-date'

export interface ComposerProject {
  id: string
  campaign_name: string
  platform: string
  client_id: string | null
  client?: { id: string; name: string; code?: string } | null
  status?: string | null
  archived_at?: string | null
  campaign_type?: string | null
  start_date?: string | null
}

interface Props {
  projects: ComposerProject[]
  /** Prefill: client, and optionally a campaign subset (campaign page). */
  initialClientId?: string
  initialProjectIds?: string[]
  preferences?: Record<string, ClientReportPreferences>
  preferencesSupported?: boolean
  canEdit: boolean
}

const FORMAT_LABEL: Record<ReportFormat, string> = {
  image_bundle: 'All pages as images (ZIP)', pdf: 'PDF', xlsx: 'Excel', csv: 'CSV', image_portrait: 'Image (portrait)', image_square: 'Image (square)',
}
const TEMPLATE_LABEL: Record<string, string> = {
  daily: 'Daily (Cirqle style)', monthly: 'Monthly (Cirqle style)', performance: 'Performance',
  executive: 'Executive summary', marketing: 'Marketing', lead_gen: 'Lead generation',
  ecommerce: 'E-commerce', agency: 'Agency',
}
const ELIGIBLE = new Set(['active', 'paused', 'completed'])

export function ReportComposer({
  projects, initialClientId, initialProjectIds, preferences = {}, preferencesSupported = false, canEdit,
}: Props) {
  const clients = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>()
    for (const p of projects) if (p.client_id) map.set(p.client_id, { id: p.client_id, name: p.client?.name ?? 'Client' })
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [projects])

  const [clientId, setClientId] = useState(initialClientId && clients.some(c => c.id === initialClientId) ? initialClientId : '')
  const clientProjects = useMemo(() => projects.filter(p => p.client_id === clientId), [projects, clientId])
  const prefs = clientId ? preferences[clientId] : undefined

  // Default scope: explicit prefill → saved default → every eligible campaign.
  function defaultSelection(cid: string): string[] {
    const own = projects.filter(p => p.client_id === cid)
    if (initialProjectIds?.length && cid === initialClientId) return initialProjectIds.filter(id => own.some(p => p.id === id))
    const saved = preferences[cid]?.defaultProjectIds.filter(id => own.some(p => p.id === id)) ?? []
    if (saved.length) return saved
    return own.filter(p => !p.archived_at && ELIGIBLE.has(p.status ?? 'active')).map(p => p.id)
  }
  const [selected, setSelected] = useState<string[]>(() => (clientId ? defaultSelection(clientId) : []))

  const initialPreset = presetByKey((prefs?.preset as PresetKey) ?? 'monthly')
  const [presetKey, setPresetKey] = useState<PresetKey>(initialPreset.key)
  const preset = presetByKey(presetKey)
  const [period, setPeriod] = useState<ComposerPeriod>(prefs?.period ?? initialPreset.defaultPeriod)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [withComparison, setWithComparison] = useState(prefs?.includeComparison ?? initialPreset.withComparison)
  const [template, setTemplate] = useState<ReportTemplate>(initialPreset.template)
  const [formats, setFormats] = useState<ReportFormat[]>(initialPreset.formats)
  const [language, setLanguage] = useState<'en' | 'ml'>(prefs?.language ?? 'en')
  const [summaryOverride, setSummaryOverride] = useState('')
  const [emailOn, setEmailOn] = useState(false)
  const [recipientsText, setRecipientsText] = useState((prefs?.recipients ?? []).map(r => r.email).join(', '))

  const [preview, setPreview] = useState<RenderData | null>(null)
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [showFull, setShowFull] = useState(false)
  const [generateAnyway, setGenerateAnyway] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [queuedId, setQueuedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const submitReport = useReportSubmission()

  function pickClient(id: string) {
    setClientId(id)
    setSelected(id ? defaultSelection(id) : [])
    const p = id ? preferences[id] : undefined
    if (p) {
      const pr = presetByKey(p.preset)
      setPresetKey(pr.key); setTemplate(pr.template); setFormats(pr.formats)
      setPeriod(p.period); setWithComparison(p.includeComparison)
      setLanguage(p.language ?? 'en'); setSummaryOverride('')
      setRecipientsText(p.recipients.map(r => r.email).join(', '))
    }
    setEmailOn(false)
  }
  function pickPreset(key: PresetKey) {
    const p = presetByKey(key)
    setPresetKey(key); setTemplate(p.template); setFormats(p.formats)
    setWithComparison(p.withComparison); setPeriod(p.defaultPeriod)
  }

  // ── Resolved request ──────────────────────────────────────────────────────
  const earliestStart = clientProjects.filter(p => selected.includes(p.id)).map(p => p.start_date).filter(Boolean).sort()[0] ?? null
  const range = period === 'custom'
    ? (isISODate(customFrom) && isISODate(customTo) ? { dateFrom: customFrom, dateTo: customTo } : null)
    : composerRange(period, todayISO(), earliestStart)
  const rangeError = !range ? 'Pick a start and end date.'
    : range.dateFrom > range.dateTo ? 'The start date is after the end date.'
    : daySpan(range.dateFrom, range.dateTo) > MAX_RANGE_DAYS ? `A report can cover at most ${MAX_RANGE_DAYS} days.`
    : null
  const recipients = recipientsText.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)

  const body = range && !rangeError && selected.length > 0 ? {
    clientId,
    ...(language === 'ml' ? { language } : {}),
    ...(summaryOverride.trim() ? { summaryOverride: summaryOverride.trim() } : {}),
    projectIds: selected,
    reportType: preset.reportType,
    template,
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    ...(withComparison ? previousPeriod(range.dateFrom, range.dateTo) : {}),
    formats,
    ...(preset.sections && template === preset.template ? { sections: preset.sections } : {}),
    ...(emailOn && recipients.length ? { recipients: recipients.map(email => ({ email })) } : {}),
  } : null
  // Recipients don't change the report's content, so they don't stale the preview.
  const contentKey = body ? JSON.stringify({ ...body, recipients: undefined }) : null
  const previewStale = preview != null && previewKey !== contentKey

  const objectives = new Set(clientProjects.filter(p => selected.includes(p.id)).map(p => p.campaign_type ?? 'unset'))

  async function runPreview() {
    if (!body) return
    setPreviewing(true); setError(null); setGenerateAnyway(false)
    try {
      const res = await fetch('/api/advertising/reports/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, saveDraft: canEdit }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Preview failed.')
      setPreview(json as RenderData); setPreviewKey(contentKey)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed.')
    } finally {
      setPreviewing(false)
    }
  }

  async function syncAndPreview() {
    if (!body) return
    setSyncing(true); setError(null)
    try {
      const res = await fetch('/api/advertising/reports/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const value = await res.json()
      if (!res.ok) throw new Error(value.error)
      await runPreview()
    } catch (error) { setError(error instanceof Error ? error.message : 'Sync failed.') }
    finally { setSyncing(false) }
  }

  // ── Data checks on the previewed snapshot ─────────────────────────────────
  const checks = useMemo(() => {
    if (!preview) return [] as { level: 'critical' | 'warning' | 'ok'; text: string }[]
    const out: { level: 'critical' | 'warning' | 'ok'; text: string }[] = []
    const q = preview.dataQuality
    if (q?.lastSyncError) out.push({ level: 'critical', text: 'The last sync failed. Sync and refresh before approving.' })
    if (q && q.expectedDays > 0 && q.recordedDays === 0) out.push({ level: 'critical', text: 'No data at all for this period — check the sync before sending this report.' })
    else if (q && q.missingCount > 0) out.push({ level: 'critical', text: describeDataQuality(q) ?? 'Some days have no data.' })
    else if (q?.includesToday) out.push({ level: 'warning', text: "Today's figures are partial." })
    const d = preview.kpi.derived
    if (d.result && !d.result.metric && d.result.unavailableReason) out.push({ level: 'warning', text: d.result.unavailableReason })
    if (d.resultCoverage && d.resultCoverage.recordedDays < d.resultCoverage.days) {
      out.push({ level: 'critical', text: `${d.result?.label ?? 'Results'} were recorded on ${d.resultCoverage.recordedDays} of ${d.resultCoverage.days} days — re-sync for complete results.` })
    }
    if (preview.kpi.periodReach && !preview.kpi.periodReach.available) out.push({ level: 'warning', text: `Unique reach: ${preview.kpi.periodReach.reason}` })
    if (preview.benchmarks.source === 'global') out.push({ level: 'warning', text: 'No real benchmarks yet — the report does not grade against benchmarks.' })
    if (out.length === 0) out.push({ level: 'ok', text: 'Data looks complete for this period.' })
    return out
  }, [preview])
  const critical = checks.some(c => c.level === 'critical')

  async function generate() {
    if (!body) return
    setSubmitting(true); setError(null)
    try {
      const queued = await submitReport({ ...body, snapshotId: preview?.snapshotId, ...(generateAnyway ? { allowIncomplete: true } : {}) })
      setQueuedId(queued.reportId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not queue the report.')
    } finally {
      setSubmitting(false)
    }
  }

  async function saveDefaults() {
    if (!clientId || period === 'custom') return
    setNotice(null); setError(null)
    const res = await saveClientReportPreferences({
      clientId, language, preset: presetKey, period, includeComparison: withComparison,
      defaultProjectIds: selected, recipients: recipients.map(email => ({ email })),
    })
    if (res.ok) setNotice('Saved as the default for this client.')
    else setError(res.error ?? 'Could not save defaults.')
  }

  const canGenerate = canEdit && body != null && preview?.snapshotId != null && !previewStale && (!critical || generateAnyway) && !submitting && !syncing && !previewing
    && (!emailOn || recipients.length > 0) && !(generateAnyway && emailOn)

  return (
    <div className="space-y-5">
      {/* ── Step 1 ── (min-w-0 on each fieldset: a fieldset defaults to
          min-width: min-content, so a long campaign name widened the page) */}
      <fieldset className="min-w-0 rounded-xl border border-border bg-card p-4 space-y-3">
        <legend className="px-1 text-sm font-semibold">1 · Client &amp; campaigns</legend>
        <label className="block text-xs font-medium text-muted-foreground">
          Client
          <select value={clientId} onChange={e => pickClient(e.target.value)}
            className="mt-1 block w-full max-w-md rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
            <option value="">Select a client…</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {clientId && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{selected.length} of {clientProjects.length} campaigns included</span>
              <span className="flex gap-3">
                <button type="button" className="hover:text-foreground" onClick={() => setSelected(clientProjects.map(p => p.id))}>All</button>
                <button type="button" className="hover:text-foreground" onClick={() => setSelected([])}>None</button>
              </span>
            </div>
            <ul className="max-h-64 overflow-y-auto rounded-lg border border-border divide-y divide-border">
              {clientProjects.map(p => (
                <li key={p.id}>
                  <label className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-secondary/40">
                    <input type="checkbox" checked={selected.includes(p.id)}
                      onChange={e => setSelected(s => e.target.checked ? [...s, p.id] : s.filter(x => x !== p.id))} />
                    <span className="min-w-0 flex-1 truncate">{p.campaign_name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {p.campaign_type ? CAMPAIGN_TYPE_LABEL[p.campaign_type] ?? p.campaign_type : 'No objective'}
                      {p.archived_at ? ' · archived' : p.status && p.status !== 'active' ? ` · ${p.status}` : ''}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {selected.length > 1 && objectives.size > 1 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                These campaigns have different objectives, so results are shown per campaign rather than added together.
              </p>
            )}
          </div>
        )}
      </fieldset>

      {/* ── Step 2 ── */}
      <fieldset className="min-w-0 rounded-xl border border-border bg-card p-4 space-y-4" disabled={!clientId}>
        <legend className="px-1 text-sm font-semibold">2 · Period &amp; purpose</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Report type">
          {REPORT_PRESETS.map(p => (
            <button key={p.key} type="button" role="radio" aria-checked={presetKey === p.key} onClick={() => pickPreset(p.key)}
              className={`rounded-lg border p-3 text-left transition-colors ${presetKey === p.key ? 'border-pink-500/50 bg-pink-500/[0.06]' : 'border-border hover:border-pink-500/30'}`}>
              <div className="text-sm font-semibold">{p.label}</div>
              <div className="text-[11px] text-muted-foreground">{p.audience}</div>
              <div className="mt-1 text-xs text-muted-foreground">{p.description}</div>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Period">
          {COMPOSER_PERIODS.map(p => (
            <button key={p.key} type="button" role="radio" aria-checked={period === p.key} onClick={() => setPeriod(p.key)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${period === p.key ? 'border-pink-500/40 bg-pink-500/10 text-pink-600 dark:text-pink-400' : 'border-border text-muted-foreground hover:text-foreground'}`}>
              {p.label}
            </button>
          ))}
          {period === 'custom' && (
            <span className="flex items-center gap-1.5 text-xs">
              <input type="date" aria-label="From" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="rounded border border-border bg-background px-1.5 py-1" />
              →
              <input type="date" aria-label="To" value={customTo} onChange={e => setCustomTo(e.target.value)} className="rounded border border-border bg-background px-1.5 py-1" />
            </span>
          )}
          {range && !rangeError && <span className="text-xs text-muted-foreground">{range.dateFrom} → {range.dateTo}</span>}
        </div>
        {rangeError && clientId && <p className="text-xs text-red-500">{rangeError}</p>}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={withComparison} onChange={e => setWithComparison(e.target.checked)} />
          Compare with the previous period of the same length
        </label>
        <label className="block text-sm">Summary language
          <select value={language} onChange={e => { setLanguage(e.target.value as 'en' | 'ml'); setSummaryOverride('') }} className="ml-3 rounded border bg-background p-2"><option value="en">English</option><option value="ml">മലയാളം</option></select>
        </label>
        <label className="block text-sm">Your summary (optional)
          <textarea value={summaryOverride} onChange={e => setSummaryOverride(e.target.value)} maxLength={3000} rows={3} placeholder="Write your own client summary, or leave blank for the suggested summary." className="mt-2 w-full rounded border bg-background p-2" />
        </label>
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground">Advanced — template and files</summary>
          <div className="mt-3 space-y-3">
            <label className="block text-xs font-medium text-muted-foreground">
              Template
              <select value={template} onChange={e => setTemplate(e.target.value as ReportTemplate)}
                className="mt-1 block w-full max-w-xs rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
                {REPORT_TEMPLATES.map(t => <option key={t} value={t}>{TEMPLATE_LABEL[t] ?? t}</option>)}
              </select>
            </label>
            <div className="flex flex-wrap gap-3">
              {REPORT_FORMATS.map(f => (
                <label key={f} className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={formats.includes(f)}
                    onChange={e => setFormats(s => e.target.checked ? [...s, f] : s.filter(x => x !== f))} />
                  {FORMAT_LABEL[f]}
                </label>
              ))}
            </div>
          </div>
        </details>
      </fieldset>

      {/* ── Step 3 ── */}
      <fieldset className="min-w-0 rounded-xl border border-border bg-card p-4 space-y-3" disabled={!body}>
        <legend className="px-1 text-sm font-semibold">3 · Preview &amp; share</legend>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={runPreview} disabled={!body || previewing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-secondary disabled:opacity-50">
            {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
            {preview ? 'Refresh preview' : 'Preview'}
          </button>
          {canEdit && <button type="button" disabled={!body || syncing || previewing} onClick={syncAndPreview} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">{syncing ? 'Syncing…' : 'Sync period & refresh preview'}</button>}
          {previewStale && <span className="text-xs text-amber-600 dark:text-amber-400">Settings changed — refresh the preview before generating.</span>}
        </div>

        {preview && !previewStale && (
          <div className="space-y-3">
            <ul className="space-y-1" aria-label="Data checks">
              {checks.map((c, i) => (
                <li key={i} className={`flex items-start gap-2 text-xs ${c.level === 'critical' ? 'text-red-600 dark:text-red-400' : c.level === 'warning' ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
                  {c.level === 'ok' ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                  {c.text}
                </li>
              ))}
            </ul>
            {critical && (
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={generateAnyway} onChange={e => setGenerateAnyway(e.target.checked)} />
                Generate anyway — the report will say the data is incomplete
              </label>
            )}
            <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm">
              <div className="font-medium">{preview.project.campaignName}</div>
              <div className="text-xs text-muted-foreground">{preview.config.dateFrom} → {preview.config.dateTo}</div>
              <p className="mt-2 text-sm text-muted-foreground">{preview.ai.executiveSummary}</p>
              <button type="button" onClick={() => setShowFull(v => !v)} className="mt-2 text-xs text-pink-600 hover:underline dark:text-pink-400">
                {showFull ? 'Hide full preview' : 'Show full preview'}
              </button>
            </div>
            {showFull && <div className="max-h-[70vh] overflow-y-auto rounded-lg border border-border"><WebReportViewer data={preview} /></div>}
          </div>
        )}

        {canEdit && (
          <div className="space-y-2 border-t border-border pt-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={emailOn} onChange={e => setEmailOn(e.target.checked)} />
              Email this report
            </label>
            {emailOn && (
              <input type="text" value={recipientsText} onChange={e => setRecipientsText(e.target.value)}
                aria-label="Recipient emails" placeholder="name@client.com, other@client.com"
                className="w-full max-w-md rounded-lg border border-border bg-background px-3 py-2 text-sm" />
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={generate} disabled={!canGenerate}
                className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                Approve &amp; generate report
              </button>
              {preferencesSupported && period !== 'custom' && (
                <button type="button" onClick={saveDefaults}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-secondary">
                  <Save className="h-3.5 w-3.5" /> Save as default for this client
                </button>
              )}
              {!preview && body && <span className="text-xs text-muted-foreground">Preview first — the report is generated from what you review.</span>}
            </div>
          </div>
        )}
        <div aria-live="polite" className="space-y-2">
          {notice && <p className="text-xs text-emerald-600 dark:text-emerald-400">{notice}</p>}
          {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
          {queuedId && (
            <div className="space-y-2">
              <ReportProgress key={queuedId} reportId={queuedId} canRetry={canEdit} />
              <Link href={`/dashboard/advertising/reports/${queuedId}`} className="inline-flex items-center gap-1 text-sm text-pink-600 hover:underline dark:text-pink-400">
                Open report — download and prepare the WhatsApp message →
              </Link>
            </div>
          )}
        </div>
      </fieldset>
    </div>
  )
}
