'use client'

/**
 * Advertising dashboard — proper KPI dashboard with campaign cards, budget
 * progress, and ad account connection CTA.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Megaphone, Plus, TrendingUp, Target, Wallet, Activity,
  ArrowRight, Inbox, Play, Loader2, Link2, BarChart3,
  MousePointerClick, Users, Zap, AlertTriangle, CheckCircle2,
  Clock, ChevronRight,
} from 'lucide-react'
import {
  AD_STATUS_CHIP, STATUS_LABEL, PLATFORM_LABEL, CAMPAIGN_TYPE_LABEL, type AdProjectRow,
} from '@/lib/advertising/types'
import { remainingBudget } from '@/lib/advertising/metrics'
import { aggregateMetrics } from '@/lib/advertising/reporting'
import { healthScore } from '@/lib/advertising/health'
import { startAdvertisingRequest } from './actions'

interface PendingRequest {
  id: string
  ref_no: number | null
  title: string
  created_at: string
  ad_meta: { platform?: string | null; campaign_type?: string | null; ad_budget?: number | null } | null
  client?: { id: string; name: string } | null
}

interface Props {
  migrated: boolean
  initialProjects: (AdProjectRow & { client?: { id: string; name: string; code: string } | null })[]
  metricsByProject: Record<string, any[]>
  pendingRequests: PendingRequest[]
  clients: { id: string; name: string; code: string }[]
  perms: { create: boolean; edit: boolean; manageBudget: boolean }
}

const inr = (v: number | null | undefined) =>
  v == null ? '—' : `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`

function daysRemaining(endDate: string | null): number | null {
  if (!endDate) return null
  const end = new Date(endDate).getTime()
  if (Number.isNaN(end)) return null
  return Math.ceil((end - Date.now()) / 86_400_000)
}

function HealthBadge({ score, label }: { score: number; label: string }) {
  const { bg, text, dot } =
    score >= 80 ? { bg: 'bg-emerald-500/10', text: 'text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500' }
    : score >= 60 ? { bg: 'bg-green-500/10', text: 'text-green-700 dark:text-green-400', dot: 'bg-green-500' }
    : score >= 40 ? { bg: 'bg-amber-500/10', text: 'text-amber-700 dark:text-amber-400', dot: 'bg-amber-500' }
    : label === 'Unknown' ? { bg: 'bg-muted/60', text: 'text-muted-foreground', dot: 'bg-muted-foreground/40' }
    : { bg: 'bg-red-500/10', text: 'text-red-700 dark:text-red-400', dot: 'bg-red-500' }

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${bg} ${text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  )
}

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  accent = false,
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

export default function AdvertisingClient({
  migrated, initialProjects, metricsByProject, pendingRequests, clients, perms,
}: Props) {
  const cards = useMemo(() => initialProjects.map(p => {
    const agg = aggregateMetrics(metricsByProject[p.id] || [])
    const health = healthScore({
      adBudget: p.ad_budget_amount, totalSpend: agg.spend,
      startDate: p.start_date, endDate: p.end_date,
      roas: agg.roas, ctr: agg.ctr, status: p.status,
    })
    return { p, agg, health, remaining: remainingBudget(p.ad_budget_amount, agg.spend), days: daysRemaining(p.end_date) }
  }), [initialProjects, metricsByProject])

  // Aggregate totals
  const totals = useMemo(() => {
    const totalSpend = cards.reduce((s, c) => s + (c.agg.spend || 0), 0)
    const totalRev = cards.reduce((s, c) => s + (c.agg.revenue || 0), 0)
    const totalImpr = cards.reduce((s, c) => s + (c.agg.impressions || 0), 0)
    const totalClicks = cards.reduce((s, c) => s + (c.agg.clicks || 0), 0)
    const totalLeads = cards.reduce((s, c) => s + (c.agg.leads || 0), 0)
    return {
      totalSpend, totalRev,
      roas: totalSpend > 0 ? (totalRev / totalSpend).toFixed(2) + '×' : '—',
      ctr: totalImpr > 0 ? ((totalClicks / totalImpr) * 100).toFixed(2) + '%' : '—',
      cpc: totalClicks > 0 ? inr(totalSpend / totalClicks) : '—',
      leads: totalLeads.toLocaleString('en-IN'),
      active: cards.filter(c => c.p.status === 'active').length,
    }
  }, [cards])

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 space-y-6">

      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Megaphone className="h-6 w-6 text-pink-500" />
            Advertising
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Campaigns, live KPIs, budgets — synced from Meta &amp; Google Ads.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/dashboard/advertising/integrations"
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

      {/* ── Migration notice ── */}
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

      {/* ── KPI Summary ── */}
      {migrated && cards.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          <KpiCard icon={Zap} label="Active" value={totals.active} sub={`of ${cards.length} campaigns`} accent />
          <KpiCard icon={Wallet} label="Total Spend" value={inr(totals.totalSpend)} />
          <KpiCard icon={TrendingUp} label="Revenue" value={inr(totals.totalRev)} />
          <KpiCard icon={BarChart3} label="Avg ROAS" value={totals.roas} />
          <KpiCard icon={MousePointerClick} label="Avg CTR" value={totals.ctr} />
          <KpiCard icon={Target} label="Avg CPC" value={totals.cpc} />
          <KpiCard icon={Users} label="Total Leads" value={totals.leads} />
        </div>
      )}

      {/* ── Pending requests ── */}
      {perms.create && pendingRequests.length > 0 && (
        <PendingRequestsSection requests={pendingRequests} />
      )}

      {/* ── Connect account CTA (empty + migrated) ── */}
      {migrated && cards.length === 0 && pendingRequests.length === 0 && (
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
                href="/dashboard/advertising/integrations"
                className="inline-flex items-center gap-2 rounded-lg gradient-bg px-4 py-2.5 text-sm font-medium text-white hover:opacity-90"
              >
                <Link2 className="h-4 w-4" />
                Connect Meta / Google Ads
              </Link>
              {perms.create && (
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
          <div className="border-t border-border bg-muted/30 px-8 py-6 grid gap-6 sm:grid-cols-3 text-center">
            {[
              { icon: Link2, step: '1', title: 'Connect Ad Account', desc: 'OAuth with Meta or Google — takes 30 seconds.' },
              { icon: Zap, step: '2', title: 'Auto-sync Campaigns', desc: 'Daily metrics pull into your dashboard automatically.' },
              { icon: BarChart3, step: '3', title: 'Track & Optimise', desc: 'ROAS, CTR, spend, leads — all in one place.' },
            ].map(({ icon: Icon, step, title, desc }) => (
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
      )}

      {/* ── Campaign Cards ── */}
      {cards.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Campaigns ({cards.length})
            </h2>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {cards.map(({ p, agg, health, remaining, days }) => (
              <Link
                key={p.id}
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
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${AD_STATUS_CHIP[p.status] || ''}`}>
                    {STATUS_LABEL[p.status] || p.status}
                  </span>
                </div>

                {/* Budget progress */}
                {p.ad_budget_amount != null && (
                  <div className="mb-3 rounded-lg bg-secondary/50 px-3 py-2">
                    <div className="flex items-center justify-between text-xs font-medium">
                      <span className="text-muted-foreground">Budget</span>
                      <span>{inr(p.ad_budget_amount)}</span>
                    </div>
                    <BudgetBar spent={agg.spend || 0} total={p.ad_budget_amount} />
                  </div>
                )}

                {/* KPI grid */}
                <div className="grid grid-cols-4 gap-2">
                  <MiniStat label="ROAS" value={agg.roas != null ? `${agg.roas}×` : '—'} />
                  <MiniStat label="CTR" value={agg.ctr != null ? `${agg.ctr}%` : '—'} />
                  <MiniStat label="CPC" value={agg.spend && agg.clicks ? inr((agg.spend) / agg.clicks) : '—'} />
                  <MiniStat label="Leads" value={agg.leads ? agg.leads.toLocaleString('en-IN') : '—'} />
                </div>

                {/* Footer */}
                <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
                  <HealthBadge score={health.score} label={health.label} />
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {days == null ? 'No end date' : days < 0 ? 'Ended' : `${days}d left`}
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </Link>
            ))}

            {/* Quick "connect account" card */}
            <Link
              href="/dashboard/advertising/integrations"
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
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-secondary/50 px-2 py-1.5 text-center">
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground font-medium">{label}</div>
      <div className="text-xs font-semibold tabular-nums mt-0.5">{value}</div>
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
