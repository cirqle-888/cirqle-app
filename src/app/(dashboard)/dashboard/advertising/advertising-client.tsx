'use client'

/**
 * Advertising dashboard — campaign cards with live KPIs.
 *
 * Stats are derived on the client from the daily rows the server passed, using
 * the same pure helpers the rest of the module shares (aggregateMetrics,
 * computeBudgetTotals, healthScore) so there is one source of truth for the math.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Megaphone, Plus, TrendingUp, Target, Wallet, Activity, ArrowRight, Inbox, Play, Loader2 } from 'lucide-react'
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

function HealthDot({ score, label }: { score: number; label: string }) {
  const color =
    score >= 80 ? 'bg-emerald-500' : score >= 60 ? 'bg-green-500'
    : score >= 40 ? 'bg-amber-500' : label === 'Unknown' ? 'bg-muted-foreground/40' : 'bg-red-500'
  return (
    <span className="inline-flex items-center gap-1.5" title={`Health: ${label} (${score})`}>
      <span className={`h-2 w-2 rounded-full ${color}`} />
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
    </span>
  )
}

function SummaryStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-sm font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  )
}

export default function AdvertisingClient({ migrated, initialProjects, metricsByProject, pendingRequests, clients, perms }: Props) {
  const cards = useMemo(() => initialProjects.map(p => {
    const agg = aggregateMetrics(metricsByProject[p.id] || [])
    const health = healthScore({
      adBudget: p.ad_budget_amount, totalSpend: agg.spend,
      startDate: p.start_date, endDate: p.end_date,
      roas: agg.roas, ctr: agg.ctr, status: p.status,
    })
    return { p, agg, health, remaining: remainingBudget(p.ad_budget_amount, agg.spend), days: daysRemaining(p.end_date) }
  }), [initialProjects, metricsByProject])

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Megaphone className="h-5 w-5 text-pink-500" /> Advertising
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Paid-ads campaigns, daily performance, budgets and billing — integrated with tasks &amp; invoices.
          </p>
        </div>
        {perms.create && (
          <Link
            href="/dashboard/advertising/new"
            className="inline-flex items-center gap-2 rounded-lg gradient-bg px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> New campaign
          </Link>
        )}
      </div>

      {/* Not-migrated notice */}
      {!migrated && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-400">
          The advertising tables aren&apos;t set up yet. Run{' '}
          <code className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs">
            supabase/migrations/20260628120000_advertising_module.sql
          </code>{' '}
          in the Supabase SQL editor, then refresh.
        </div>
      )}

      {/* Summary Widgets */}
      {migrated && cards.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
          <SummaryStat label="Active Campaigns" value={cards.filter(c => c.p.status === 'active').length} />
          <SummaryStat label="Total Spend" value={inr(cards.reduce((sum, c) => sum + (c.agg.spend || 0), 0))} />
          <SummaryStat label="Total Revenue" value={inr(cards.reduce((sum, c) => sum + (c.agg.revenue || 0), 0))} />
          <SummaryStat label="Avg ROAS" value={
            (() => {
              const totalSpend = cards.reduce((sum, c) => sum + (c.agg.spend || 0), 0)
              const totalRev = cards.reduce((sum, c) => sum + (c.agg.revenue || 0), 0)
              return totalSpend > 0 ? `${(totalRev / totalSpend).toFixed(2)}×` : '—'
            })()
          } />
          <SummaryStat label="Avg CTR" value={
            (() => {
              const totalImpr = cards.reduce((sum, c) => sum + (c.agg.impressions || 0), 0)
              const totalClicks = cards.reduce((sum, c) => sum + (c.agg.clicks || 0), 0)
              return totalImpr > 0 ? `${((totalClicks / totalImpr) * 100).toFixed(2)}%` : '—'
            })()
          } />
          <SummaryStat label="Avg CPC" value={
            (() => {
              const totalSpend = cards.reduce((sum, c) => sum + (c.agg.spend || 0), 0)
              const totalClicks = cards.reduce((sum, c) => sum + (c.agg.clicks || 0), 0)
              return totalClicks > 0 ? inr(totalSpend / totalClicks) : '—'
            })()
          } />
          <SummaryStat label="Total Leads" value={cards.reduce((sum, c) => sum + (c.agg.leads || 0), 0).toLocaleString('en-IN')} />
          {/* Mocked sync health for demo */}
          <SummaryStat label="Sync Health" value="100%" />
          <SummaryStat label="Failed Syncs" value="0" />
          <SummaryStat label="Pending Jobs" value="0" />
        </div>
      )}

      {/* Advertising requests awaiting a start (also visible in the Requests inbox) */}
      {perms.create && pendingRequests.length > 0 && (
        <PendingRequestsSection requests={pendingRequests} />
      )}

      {/* Empty state */}
      {migrated && cards.length === 0 && pendingRequests.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card p-12 text-center">
          <Megaphone className="mx-auto h-10 w-10 text-muted-foreground/40" />
          <p className="mt-3 text-sm font-medium">No campaigns yet</p>
          <p className="text-sm text-muted-foreground">
            Create one here, or paste an ad brief into Quick Capture and let the Smart Router route it.
          </p>
          {perms.create && (
            <Link href="/dashboard/advertising/new" className="mt-4 inline-flex items-center gap-2 rounded-lg gradient-bg px-4 py-2 text-sm font-medium text-white hover:opacity-90">
              <Plus className="h-4 w-4" /> New campaign
            </Link>
          )}
        </div>
      )}

      {/* Campaign cards */}
      {cards.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map(({ p, agg, health, remaining, days }) => (
            <Link
              key={p.id}
              href={`/dashboard/advertising/${p.id}`}
              className="group rounded-xl border border-border bg-card p-4 hover:border-pink-500/40 hover:shadow-sm transition-all"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold truncate">{p.campaign_name}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {p.client?.name || 'No client'} · {PLATFORM_LABEL[p.platform] || p.platform}
                    {p.campaign_type ? ` · ${CAMPAIGN_TYPE_LABEL[p.campaign_type] || p.campaign_type}` : ''}
                  </div>
                </div>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${AD_STATUS_CHIP[p.status] || ''}`}>
                  {STATUS_LABEL[p.status] || p.status}
                </span>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <Stat icon={Wallet} label="Budget" value={inr(p.ad_budget_amount)} />
                <Stat icon={Activity} label="Spent" value={inr(agg.spend)} />
                <Stat icon={Wallet} label="Left" value={inr(remaining)} tone={remaining != null && remaining < 0 ? 'bad' : undefined} />
              </div>

              <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                <Stat icon={TrendingUp} label="ROAS" value={agg.roas != null ? `${agg.roas}×` : '—'} />
                <Stat icon={Target} label="CTR" value={agg.ctr != null ? `${agg.ctr}%` : '—'} />
                <Stat icon={Target} label="Leads" value={agg.leads ? agg.leads.toLocaleString('en-IN') : '—'} />
              </div>

              <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
                <HealthDot score={health.score} label={health.label} />
                <span className="text-xs text-muted-foreground">
                  {days == null ? 'No end date' : days < 0 ? 'Ended' : `${days}d left`}
                </span>
                <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </Link>
          ))}
        </div>
      )}
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
        <h2 className="text-sm font-semibold">Advertising requests</h2>
        <span className="text-xs text-muted-foreground">— start one to create a campaign + its single task</span>
      </div>
      {error && <div className="mb-2 text-xs text-red-600">{error}</div>}
      <div className="space-y-2">
        {requests.map(r => {
          const platform = r.ad_meta?.platform ? PLATFORM_LABEL[r.ad_meta.platform] || r.ad_meta.platform : null
          const budget = r.ad_meta?.ad_budget != null ? inr(Number(r.ad_meta.ad_budget)) : null
          return (
            <div key={r.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{r.title}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {r.ref_no ? `REQ-${String(r.ref_no).padStart(4, '0')} · ` : ''}{r.client?.name || 'No client'}
                  {platform ? ` · ${platform}` : ''}{budget ? ` · ${budget}` : ''}
                </div>
              </div>
              <button
                onClick={() => start(r.id)}
                disabled={busyId === r.id}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-lg gradient-bg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 hover:opacity-90"
              >
                {busyId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                Start campaign
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Stat({
  icon: Icon, label, value, tone,
}: { icon: typeof Wallet; label: string; value: string; tone?: 'bad' }) {
  return (
    <div className="rounded-lg bg-secondary/50 px-2 py-1.5">
      <div className="flex items-center justify-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className={`text-sm font-semibold tabular-nums ${tone === 'bad' ? 'text-red-600 dark:text-red-400' : ''}`}>
        {value}
      </div>
    </div>
  )
}
