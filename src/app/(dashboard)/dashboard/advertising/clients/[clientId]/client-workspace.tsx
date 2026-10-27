'use client'

/**
 * Client workspace — one client's campaigns, money and reports.
 *
 * Tabs: Overview (period results, needs attention) · Campaigns · Funds &
 * billing (wallet, allocations, history) · Reports. Every number comes from
 * the same builders as the overview (advertising-client.tsx), so the two
 * screens always agree. Tab and period live in the URL.
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, Building2, FileText, Plus, Target, Wallet, Zap } from 'lucide-react'
import {
  AttentionPanel, CampaignCard, KpiCard, WalletStat, AddFundsForm, LedgerHistory,
  buildCampaignCards, computeAttentionItems, allocationsByProject,
  type AttentionData, type LedgerRowView, type FundCandidate,
} from '../../advertising-client'
import { ReportCard, type Report } from '../../reports/reports-client'
import { ReportComposer } from '@/components/reporting/report-composer'
import type { ClientReportPreferences } from '@/lib/reporting/preferences'
import type { AdProjectRow } from '@/lib/advertising/types'
import type { BenchmarkResult } from '@/lib/advertising/ai/benchmarks'
import { PERIODS, DEFAULT_PERIOD, isPeriodKey, periodRange, type PeriodKey } from '@/lib/advertising/period'
import { spendWithGst } from '@/lib/advertising/budget'
import { todayISO } from '@/lib/utils/local-date'
import { ClientAdFundsPanel } from '../../funds/funds-client'
import type { ClientFundsData } from '../../funds/_data'

type Tab = 'overview' | 'campaigns' | 'funds' | 'reports'
type ProjectRow = AdProjectRow & { client?: { id: string; name: string; code: string } | null }

interface Props {
  client: { id: string; name: string; code: string }
  migrated: boolean
  projects: ProjectRow[]
  metricsByProject: Record<string, any[]>
  benchmarksByProject: Record<string, BenchmarkResult>
  attention: AttentionData
  walletSupported: boolean
  ledger: LedgerRowView[]
  fundCandidates: FundCandidate[]
  reports: Report[]
  reportPreferences?: Record<string, ClientReportPreferences>
  reportPreferencesSupported?: boolean
  perms: { create: boolean; edit: boolean; manageBudget: boolean; viewFinancials: boolean; viewBilling: boolean; viewReports: boolean }
  /**
   * Rendered inside the Client Marketing Hub: no back link or title (the hub
   * has its own), and the sub-tab lives under its own URL key so it does not
   * fight the hub's `tab`.
   */
  embedded?: boolean
  tabKey?: string
  /** Meta ad funds for this client (top-up, suggestion, statement) — view_financials only. */
  adFunds?: ClientFundsData | null
}

const inr = (v: number, dp = 0) => `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: dp })}`
const round2 = (v: number) => Math.round(v * 100) / 100

export default function ClientWorkspace({
  client, migrated, projects, metricsByProject, benchmarksByProject, attention,
  walletSupported, ledger, fundCandidates, reports, reportPreferences = {}, reportPreferencesSupported = false, perms,
  embedded = false, tabKey = 'tab', adFunds = null,
}: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const rawPeriod = searchParams.get('period')
  const period: PeriodKey = isPeriodKey(rawPeriod) ? rawPeriod : DEFAULT_PERIOD
  const rawTab = searchParams.get(tabKey)
  const canSeeFunds = perms.viewFinancials || perms.viewBilling
  const tab: Tab = rawTab === 'campaigns' || rawTab === 'reports' || (rawTab === 'funds' && canSeeFunds) ? rawTab : 'overview'
  const range = useMemo(() => periodRange(period, todayISO()), [period])
  const [showArchived, setShowArchived] = useState(false)
  const [showAdd, setShowAdd] = useState(false)

  function setParam(key: string, value: string, fallback: string) {
    const q = new URLSearchParams(searchParams.toString())
    if (value === fallback) q.delete(key); else q.set(key, value)
    // Native history: updates useSearchParams without a server round trip
    // (Next.js integrates replaceState with the router).
    window.history.replaceState(null, '', q.size ? `${pathname}?${q}` : pathname)
  }

  const allocated = useMemo(() => allocationsByProject(ledger), [ledger])
  const cards = useMemo(
    () => buildCampaignCards(projects, metricsByProject, allocated, benchmarksByProject, range),
    [projects, metricsByProject, allocated, benchmarksByProject, range],
  )
  const live = cards.filter(c => !c.p.archived_at)
  const attentionItems = useMemo(
    () => computeAttentionItems(attention, cards, metricsByProject, walletSupported),
    [attention, cards, metricsByProject, walletSupported],
  )

  const wallet = useMemo(() => {
    let credited = 0, allocatedTotal = 0
    for (const r of ledger) {
      if (r.direction === 'credit') credited += Number(r.amount_inr || 0)
      else allocatedTotal += Number(r.amount_inr || 0)
    }
    const lifetimeSpend = cards.reduce((s, c) => s + (c.agg.spend || 0), 0)
    return {
      credited: round2(credited), allocated: round2(allocatedTotal),
      balance: round2(credited - allocatedTotal),
      spend: round2(lifetimeSpend),
      unspent: round2(allocatedTotal - spendWithGst(lifetimeSpend)),
    }
  }, [ledger, cards])

  // Period results grouped by objective result (never one mixed total).
  const results = useMemo(() => {
    const by = new Map<string, { label: string; costLabel: string; count: number; spend: number }>()
    for (const c of live) {
      const m = c.definition.metric
      if (!m || c.periodResults == null) continue
      const g = by.get(m) ?? { label: c.definition.label, costLabel: c.definition.costLabel, count: 0, spend: 0 }
      g.count += c.periodResults
      g.spend += c.periodAgg.spend || 0
      by.set(m, g)
    }
    return [...by.values()]
  }, [live])
  const periodSpend = live.reduce((s, c) => s + (c.periodAgg.spend || 0), 0)

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'campaigns', label: `Campaigns (${live.length})` },
    ...(canSeeFunds ? [{ key: 'funds' as const, label: 'Funds & billing' }] : []),
    ...(perms.viewReports ? [{ key: 'reports' as const, label: 'Reports' }] : []),
  ]

  const reportsHref = (() => {
    const q = new URLSearchParams(searchParams.toString())
    q.set(tabKey, 'reports')
    return `${pathname}?${q}`
  })()

  return (
    <div className={embedded ? 'space-y-5' : 'mx-auto max-w-7xl space-y-6 px-4 py-8'}>
      {!embedded && (
        <Link href="/dashboard/advertising" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Advertising
        </Link>
      )}

      <div className={`flex flex-wrap items-start gap-3 ${embedded ? 'justify-end' : 'justify-between'}`}>
        {!embedded && (
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <Building2 className="h-6 w-6 text-pink-500" /> {client.name}
              {client.code && <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-semibold text-muted-foreground">{client.code}</span>}
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">Campaigns, funds and reports for this client.</p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {perms.viewReports && (
            <Link href={reportsHref}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:border-pink-500/40">
              <FileText className="h-4 w-4 text-pink-500" /> Prepare client report
            </Link>
          )}
          {perms.create && !embedded && (
            <Link href={`/dashboard/advertising/new?client=${client.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-4 py-2 text-sm font-medium text-white hover:opacity-90">
              <Plus className="h-4 w-4" /> New Campaign
            </Link>
          )}
        </div>
      </div>

      {!migrated && <p className="text-sm text-muted-foreground">Advertising tables are not set up yet.</p>}

      <div className="flex flex-wrap gap-1 border-b border-border" role="tablist">
        {tabs.map(t => (
          <button key={t.key} role="tab" aria-selected={tab === t.key}
            onClick={() => setParam(tabKey, t.key, 'overview')}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.key ? 'border-pink-500 text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {(tab === 'overview' || tab === 'campaigns') && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Reporting period">
          {PERIODS.map(p => (
            <button key={p.key} onClick={() => setParam('period', p.key, DEFAULT_PERIOD)} aria-pressed={period === p.key}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                period === p.key ? 'border-pink-500/40 bg-pink-500/10 text-pink-600 dark:text-pink-400' : 'border-border bg-card text-muted-foreground hover:text-foreground'
              }`}>
              {p.label}
            </button>
          ))}
          <span className="text-xs text-muted-foreground">{range.from ? `${range.from} → ${range.to}` : `up to ${range.to}`}</span>
        </div>
      )}

      {tab === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard icon={Zap} label="Active" value={live.filter(c => c.p.status === 'active').length} sub={`of ${live.length} campaigns`} accent />
            <KpiCard icon={Wallet} label="Spend" value={inr(periodSpend)} sub={`${range.label} · excl. GST`} />
            {results.length > 0
              ? results.slice(0, 3).map(r => (
                  <KpiCard key={r.label} icon={Target} label={r.label} value={r.count.toLocaleString('en-IN')}
                    sub={r.count > 0 ? `${r.costLabel} ${inr(r.spend / r.count, 2)}` : 'none in this period'} />
                ))
              : <KpiCard icon={Target} label="Results" value="—" sub="No objective results in this period" />}
            {walletSupported && perms.viewFinancials && (
              <KpiCard icon={Wallet} label="Wallet balance" value={inr(wallet.balance, 2)} sub={`${inr(wallet.unspent, 2)} allocated but unspent`} />
            )}
          </div>
          <AttentionPanel items={attentionItems} canSnooze={perms.edit && attention.snoozeSupported} />
        </div>
      )}

      {tab === 'campaigns' && (
        <div className="space-y-3">
          <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Show archived
          </label>
          {(showArchived ? cards : live).length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">No campaigns for this client yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {(showArchived ? cards : live).map(c => (
                <CampaignCard key={c.p.id} card={c} walletOn={walletSupported} showBilling={perms.viewBilling} />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'funds' && canSeeFunds && (
        <div className="space-y-4">
          {adFunds?.migrated && perms.viewFinancials && (
            <ClientAdFundsPanel funds={adFunds} clientName={client.name} canManage={perms.manageBudget} onDone={() => router.refresh()} />
          )}
          {!walletSupported ? (
            <p className="text-sm text-muted-foreground">Client wallets are not set up yet.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {perms.viewFinancials && <WalletStat label="Wallet credited" value={inr(wallet.credited, 2)} />}
                <WalletStat label="Allocated to campaigns" value={inr(wallet.allocated, 2)} />
                {perms.viewFinancials && <WalletStat label="Unallocated balance" value={inr(wallet.balance, 2)} tone={wallet.balance < 0 ? 'bad' : wallet.balance > 0 ? 'good' : undefined} />}
                <WalletStat label="Spend, lifetime (excl. GST)" value={inr(wallet.spend, 2)} />
                <WalletStat label="Allocated, unspent (incl. GST)" value={inr(wallet.unspent, 2)} tone={wallet.unspent < 0 ? 'bad' : undefined} />
              </div>
              <p className="text-xs text-muted-foreground">
                Funds stay separate from performance: these are wallet movements from the ledger, not the campaign&apos;s results.
                Allocate funds to a campaign from its Funds &amp; billing tab.
              </p>
              {perms.viewFinancials && (
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold">Wallet history</h2>
                    {perms.manageBudget && (
                      <button onClick={() => setShowAdd(v => !v)}
                        className="inline-flex items-center gap-1 rounded-lg gradient-bg px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90">
                        <Plus className="h-3.5 w-3.5" /> Add funds
                      </button>
                    )}
                  </div>
                  {showAdd && perms.manageBudget && (
                    <AddFundsForm clientId={client.id} candidates={fundCandidates} onDone={() => { setShowAdd(false); router.refresh() }} />
                  )}
                  <LedgerHistory rows={ledger} canManage={perms.manageBudget} onChange={() => router.refresh()} />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'reports' && perms.viewReports && (
        <div className="space-y-6">
          {perms.edit && (
            <section aria-labelledby="prepare-report" className="space-y-3">
              <h2 id="prepare-report" className="text-sm font-semibold">Prepare a report</h2>
              <ReportComposer projects={projects} initialClientId={client.id}
                preferences={reportPreferences} preferencesSupported={reportPreferencesSupported} canEdit={perms.edit} />
            </section>
          )}
          <h2 className="text-sm font-semibold">Recent reports</h2>
          {reports.length === 0
            ? <p className="py-6 text-sm text-muted-foreground">No reports for this client yet.</p>
            : reports.map(r => <ReportCard key={r.id} report={r} />)}
          {reports.length >= 25 && (
            <Link href="/dashboard/advertising/reports" className="text-xs text-muted-foreground hover:text-foreground">See full history in the Reports hub →</Link>
          )}
        </div>
      )}
    </div>
  )
}
