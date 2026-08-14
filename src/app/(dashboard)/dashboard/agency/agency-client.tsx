'use client'

/**
 * Agency master dashboard — totals, per-client social/leads/ads table, AI
 * insights and configurable performance alerts.
 */

import { useMemo, useState, useTransition } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import AppSelect from '@/components/ui/app-select'
import { EmptyState } from '@/components/ui/empty-state'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ToastContainer, useToast } from '@/components/ui/toast'
import {
  Sparkles, Loader2, FileText, Bell, Plus, Trash2, X, ArrowUpRight, ArrowDownRight,
  TrendingUp, Users, IndianRupee, Target, AlertTriangle, ExternalLink,
} from 'lucide-react'
import type { ClientRollup, AgencyTotals } from '@/lib/integrations/meta/aggregate'
import type { MetaNarrative } from '@/lib/integrations/meta/ai-insights'
import {
  generateAgencyInsights, runAlertsNow, saveAlertRule, toggleAlertRule, deleteAlertRule,
  type AlertRuleInput,
} from './actions'

interface AlertRule { id: string; client_id: string | null; metric: string; threshold: number; is_active: boolean }

const RANGES = [{ key: 'last7', label: '7 days' }, { key: 'last30', label: '30 days' }, { key: 'last90', label: '90 days' }]
const HEALTH_DOT: Record<string, string> = { green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500' }
const METRIC_LABEL: Record<string, string> = {
  cpl_above: 'Cost per lead above ₹', leads_drop_pct: 'Leads drop more than %', reach_drop_pct: 'Reach drop more than %',
  spend_increase_pct: 'Spend increase more than %', stale_sync_hours: 'No sync for hours', roas_below: 'ROAS below (×)', ctr_below: 'CTR below %',
}
const compact = (n: number | null | undefined) => (n == null ? '—' : Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(n))
const inr = (n: number | null | undefined) => (n == null ? '—' : `₹${Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(n)}`)

export default function AgencyClient({
  rollups, totals, rangeKey, rules: initialRules, canManageAlerts,
}: {
  rollups: ClientRollup[]
  totals: AgencyTotals
  rangeKey: string
  rules: AlertRule[]
  canManageAlerts: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const toast = useToast()
  const [, startTransition] = useTransition()

  const days = rangeKey === 'last7' ? 7 : rangeKey === 'last90' ? 90 : 30
  const [insights, setInsights] = useState<MetaNarrative | null>(null)
  const [genBusy, setGenBusy] = useState(false)
  const [rules, setRules] = useState<AlertRule[]>(initialRules)
  const [showAlerts, setShowAlerts] = useState(false)
  const [ruleModal, setRuleModal] = useState<AlertRule | 'new' | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AlertRule | null>(null)

  const setRange = (key: string) => router.push(`${pathname}?range=${key}`)

  const active = useMemo(() => rollups.filter((r) => r.accountsConnected > 0 || r.spend > 0 || r.leads > 0), [rollups])

  return (
    <>
      <Header
        title="Agency dashboard"
        subtitle="Every client's social, leads and ads in one view"
        actions={
          <div className="flex items-center gap-2">
            <AppSelect value={rangeKey} onChange={(e) => setRange(e.target.value)} wrapperClassName="w-auto">
              {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </AppSelect>
            {canManageAlerts && <Button size="sm" variant="secondary" onClick={() => setShowAlerts(true)}><Bell className="w-4 h-4 mr-1.5" /> Alerts</Button>}
          </div>
        }
      />

      <div className="px-4 sm:px-6 pb-16 max-w-[1500px] mx-auto w-full space-y-4">
        {/* CLIENT performance. Labelled explicitly because these figures now
            deliberately EXCLUDE Cirqle's own accounts and anything untriaged —
            a total that silently mixed them would misstate what clients got. */}
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Client performance
        </p>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2.5">
          <Tile icon={<Users className="w-4 h-4" />} label="Clients" value={String(totals.clients)} sub={`${totals.connectedAccounts} accounts`} />
          <Tile icon={<TrendingUp className="w-4 h-4" />} label="Total reach" value={compact(totals.totalReach)} />
          <Tile icon={<Target className="w-4 h-4" />} label="Total leads" value={compact(totals.totalLeads)} />
          <Tile icon={<IndianRupee className="w-4 h-4" />} label="Ad spend" value={inr(totals.totalSpend)} />
          <Tile label="Avg CPL" value={totals.avgCpl != null ? `₹${totals.avgCpl}` : '—'} />
          <Tile label="Content published" value={String(totals.contentPublished)} />
        </div>
        {/* CIRQLE performance — our own marketing, side by side but never
            added in. Hidden entirely when we own nothing, so the section only
            appears once it means something. */}
        {totals.cirqle.accounts > 0 && (
          <>
            <div className="flex items-center gap-2 pt-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
                Cirqle performance
              </p>
              <span className="text-[10px] text-muted-foreground">
                our own accounts — excluded from every client figure above
              </span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
              <Tile label="Our accounts" value={String(totals.cirqle.accounts)} />
              <Tile label="Our reach" value={compact(totals.cirqle.reach)} />
              <Tile label="Our views" value={compact(totals.cirqle.views)} />
              <Tile label="Our leads" value={compact(totals.cirqle.leads)} />
            </div>
          </>
        )}

        {/* Unassigned — the number that costs money by sitting there, because
            until an asset has an owner its reach and spend land in no report. */}
        {totals.unassignedAssets > 0 && (
          <Link href="/dashboard/assets"
            className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300 hover:bg-amber-500/15 transition-colors">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>
              <strong>{totals.unassignedAssets}</strong> discovered asset{totals.unassignedAssets === 1 ? '' : 's'} not
              assigned to anyone — {totals.unassignedAssets === 1 ? 'it appears' : 'they appear'} in no report until triaged.
            </span>
            <span className="ml-auto underline shrink-0">Assign</span>
          </Link>
        )}

        {(totals.accountsNeedReauth > 0 || totals.syncFailures > 0 || totals.reportsPending > 0) && (
          <div className="flex flex-wrap gap-2 text-xs">
            {totals.accountsNeedReauth > 0 && <span className="px-2.5 py-1 rounded-md bg-red-500/10 text-red-400 border border-red-500/20 inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{totals.accountsNeedReauth} account(s) need re-auth</span>}
            {totals.syncFailures > 0 && <span className="px-2.5 py-1 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/20">{totals.syncFailures} stale sync(s)</span>}
            {totals.reportsPending > 0 && <span className="px-2.5 py-1 rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/20">{totals.reportsPending} report(s) generating</span>}
          </div>
        )}

        {/* AI insights */}
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-semibold flex items-center gap-1.5"><Sparkles className="w-4 h-4 text-primary" /> AI insights</div>
              <Button
                size="sm" variant="secondary" disabled={genBusy}
                onClick={() => { setGenBusy(true); startTransition(async () => { const r = await generateAgencyInsights(days); setGenBusy(false); if (r.ok && r.data) setInsights(r.data); else toast.error('Could not generate', r.error) }) }}
              >
                {genBusy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1.5" />}
                {insights ? 'Regenerate' : 'Generate insights'}
              </Button>
            </div>
            {!insights ? (
              <p className="text-sm text-muted-foreground">Generate an AI reading of this period across all clients — wins, weak areas and recommendations, computed from your verified data.</p>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-foreground leading-relaxed">{insights.summary}</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <InsightList title="Key wins" color="text-emerald-400" items={insights.wins} />
                  <InsightList title="Weak areas" color="text-red-400" items={insights.weak} />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="text-sm"><span className="text-xs text-muted-foreground">Content</span><p className="text-foreground">{insights.contentInsight}</p></div>
                  <div className="text-sm"><span className="text-xs text-muted-foreground">Leads</span><p className="text-foreground">{insights.leadInsight}</p></div>
                </div>
                <InsightList title="Recommendations" color="text-primary" items={insights.recommendations} />
                <div className="text-[10px] text-muted-foreground">{insights.ruleBased ? 'Rule-based (set GROQ_API_KEY for AI narratives). Figures are exact.' : 'AI interpretation of verified data — figures are exact.'}</div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Client table */}
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {active.length === 0 ? (
              <EmptyState icon={Users} title="No client activity yet" body="Once clients have connected Meta accounts, captured leads or running campaigns, they appear here with reach, leads, spend and health." />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="font-medium px-3 py-2.5">Client</th>
                    <th className="font-medium px-3 py-2.5 text-right">Reach</th>
                    <th className="font-medium px-3 py-2.5 text-right">Leads</th>
                    <th className="font-medium px-3 py-2.5 text-right hidden sm:table-cell">Spend</th>
                    <th className="font-medium px-3 py-2.5 text-right hidden md:table-cell">CPL</th>
                    <th className="font-medium px-3 py-2.5 text-right hidden lg:table-cell">ROAS</th>
                    <th className="font-medium px-3 py-2.5 text-center">Health</th>
                    <th className="font-medium px-3 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((r) => (
                    <tr key={r.clientId} className="border-b border-border/60 last:border-0 hover:bg-secondary/40">
                      <td className="px-3 py-2.5">
                        <Link href={`/dashboard/clients/${r.clientId}`} className="font-medium text-foreground hover:text-primary">{r.clientName}</Link>
                        <div className="text-xs text-muted-foreground">{r.accountsConnected} account{r.accountsConnected === 1 ? '' : 's'} · {r.contentPublished} posts</div>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {compact(r.reach)}
                        {r.reachDeltaPct != null && <span className={`ml-1 text-[11px] inline-flex items-center ${r.reachDeltaPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{r.reachDeltaPct >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}{Math.abs(r.reachDeltaPct)}%</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {r.leads}
                        {r.leadsDeltaPct != null && <span className={`ml-1 text-[11px] ${r.leadsDeltaPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{r.leadsDeltaPct >= 0 ? '+' : ''}{r.leadsDeltaPct}%</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums hidden sm:table-cell">{inr(r.spend)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums hidden md:table-cell">{r.cpl != null ? `₹${r.cpl}` : '—'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums hidden lg:table-cell">{r.roas != null ? `${r.roas}×` : '—'}</td>
                      <td className="px-3 py-2.5 text-center"><span className={`inline-block w-2.5 h-2.5 rounded-full ${HEALTH_DOT[r.health]}`} title={r.health} /></td>
                      <td className="px-3 py-2.5 text-right">
                        <a href={`/api/social/report?clientId=${r.clientId}&days=${days}`} target="_blank" rel="noopener noreferrer" title="Branded report" className="text-muted-foreground hover:text-primary inline-flex"><FileText className="w-4 h-4" /></a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <div className="text-xs text-muted-foreground flex gap-3">
          <Link href="/dashboard/social" className="text-primary hover:underline">Social hub</Link>
          <Link href="/dashboard/leads" className="text-primary hover:underline">Leads</Link>
          <Link href="/dashboard/advertising" className="text-primary hover:underline">Advertising</Link>
        </div>
      </div>

      {/* Alerts drawer */}
      {showAlerts && (
        <ModalOverlay onClose={() => setShowAlerts(false)} sheetOnMobile>
          <div className="bg-card w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card">
              <h2 className="text-base font-semibold flex items-center gap-1.5"><Bell className="w-4 h-4" /> Performance alerts</h2>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => startTransition(async () => { const r = await runAlertsNow(); if (r.ok) toast.success('Alerts checked', `${r.data?.triggered ?? 0} triggered`); else toast.error('Failed', r.error) })}>Run now</Button>
                <button onClick={() => setShowAlerts(false)} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
              </div>
            </div>
            <div className="p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-muted-foreground">Admins are notified when a threshold is breached (checked daily).</p>
                <Button size="sm" onClick={() => setRuleModal('new')}><Plus className="w-4 h-4 mr-1" /> Rule</Button>
              </div>
              <div className="space-y-2">
                {rules.length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">No rules yet.</p>}
                {rules.map((rule) => (
                  <div key={rule.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                    <div className="text-sm">
                      <span className="font-medium">{METRIC_LABEL[rule.metric] ?? rule.metric}{rule.threshold}</span>
                      {!rule.is_active && <Badge variant="default" className="ml-2">Paused</Badge>}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => { setRules((p) => p.map((x) => x.id === rule.id ? { ...x, is_active: !x.is_active } : x)); startTransition(async () => { const r = await toggleAlertRule(rule.id, !rule.is_active); if (!r.ok) toast.error('Failed', r.error) }) }}>{rule.is_active ? 'Pause' : 'Resume'}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setRuleModal(rule)}>Edit</Button>
                      <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-300" onClick={() => setDeleteTarget(rule)}><Trash2 className="w-4 h-4" /></Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </ModalOverlay>
      )}

      {ruleModal && (
        <AlertRuleModal
          rule={ruleModal === 'new' ? null : ruleModal}
          onClose={() => setRuleModal(null)}
          onSave={(input) => new Promise((resolve) => startTransition(async () => {
            const r = await saveAlertRule(input)
            if (!r.ok) { toast.error('Could not save', r.error); resolve(false); return }
            const saved: AlertRule = { id: r.data!.id, client_id: input.client_id, metric: input.metric, threshold: input.threshold, is_active: input.is_active ?? true }
            setRules((p) => p.some((x) => x.id === saved.id) ? p.map((x) => x.id === saved.id ? saved : x) : [...p, saved])
            setRuleModal(null); resolve(true)
          }))}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog title="Delete alert rule?" body="This threshold stops being checked." confirmLabel="Delete" danger
          onConfirm={() => { const id = deleteTarget.id; setDeleteTarget(null); setRules((p) => p.filter((x) => x.id !== id)); startTransition(async () => { const r = await deleteAlertRule(id); if (!r.ok) toast.error('Failed', r.error) }) }}
          onCancel={() => setDeleteTarget(null)} />
      )}

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </>
  )
}

function Tile({ icon, label, value, sub }: { icon?: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-3">
      <div className="text-xs text-muted-foreground flex items-center gap-1">{icon}{label}</div>
      <div className="text-xl font-semibold text-foreground mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  )
}

function InsightList({ title, color, items }: { title: string; color: string; items: string[] }) {
  return (
    <div>
      <div className={`text-xs font-semibold ${color}`}>{title}</div>
      {items.length ? (
        <ul className="mt-1 space-y-1">{items.map((i, x) => <li key={x} className="text-sm text-foreground/90 flex gap-1.5"><span className="text-muted-foreground">•</span>{i}</li>)}</ul>
      ) : <div className="text-sm text-muted-foreground">—</div>}
    </div>
  )
}

function AlertRuleModal({ rule, onClose, onSave }: { rule: AlertRule | null; onClose: () => void; onSave: (input: AlertRuleInput) => Promise<boolean> }) {
  const [metric, setMetric] = useState(rule?.metric ?? 'cpl_above')
  const [threshold, setThreshold] = useState(String(rule?.threshold ?? 500))
  const [saving, setSaving] = useState(false)
  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card w-full sm:max-w-sm sm:rounded-2xl rounded-t-2xl">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-base font-semibold">{rule ? 'Edit rule' : 'New alert rule'}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">Alert when</label>
            <AppSelect value={metric} onChange={(e) => setMetric(e.target.value)} className="mt-1">
              {Object.entries(METRIC_LABEL).map(([k, v]) => <option key={k} value={k}>{v.replace(/[₹%()×]/g, '').trim()}</option>)}
            </AppSelect>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Threshold ({METRIC_LABEL[metric].match(/[₹%×]/)?.[0] ?? 'value'})</label>
            <input type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} className="mt-1 w-full h-9 px-3 rounded-lg bg-secondary text-sm border border-border" />
          </div>
          <p className="text-[11px] text-muted-foreground">Applies to all clients. (Per-client rules can be added later.)</p>
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={saving} onClick={async () => { setSaving(true); const ok = await onSave({ id: rule?.id, client_id: rule?.client_id ?? null, metric, threshold: Number(threshold), is_active: rule?.is_active ?? true }); setSaving(false); if (ok) return }}>
            {saving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}Save
          </Button>
        </div>
      </div>
    </ModalOverlay>
  )
}
