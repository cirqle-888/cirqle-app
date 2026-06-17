'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { History, TrendingUp, ShieldCheck, Award } from 'lucide-react'
import type { ClientScore, ClientClass } from '@/lib/clients/scoring'

type Tab = 'strategic' | 'reliability' | 'value'

const CLASS_STYLE: Record<ClientClass, string> = {
  'Strategic Client':      'bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-400',
  'Growth Client':         'bg-blue-500/15 text-blue-700 border-blue-500/30 dark:text-blue-400',
  'High Value Risk':       'bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-400',
  'Reliable Small Client': 'bg-teal-500/15 text-teal-700 border-teal-500/30 dark:text-teal-400',
  'Watchlist Client':      'bg-red-500/15 text-red-700 border-red-500/30 dark:text-red-400',
}

const fmtINR = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const fmtDays = (n: number | null) => n == null ? '—' : `${n}d`
const fmtPct  = (n: number | null) => n == null ? '—' : `${n}%`

export default function RankingClient({ scores, showAmounts }: { scores: ClientScore[]; showAmounts: boolean }) {
  const [tab, setTab] = useState<Tab>('strategic')
  const [search, setSearch] = useState('')

  const sorted = useMemo(() => {
    const list = scores.filter(s => !search || s.clientName.toLowerCase().includes(search.toLowerCase()))
    const key = tab === 'strategic' ? 'strategicScore' : tab === 'reliability' ? 'reliability' : 'value'
    return [...list].sort((a, b) => {
      const av = tab === 'strategic' ? a.strategicScore : tab === 'reliability' ? a.reliability.score : a.value.score
      const bv = tab === 'strategic' ? b.strategicScore : tab === 'reliability' ? b.reliability.score : b.value.score
      return bv - av
    })
  }, [scores, tab, search])

  const counts = useMemo(() => {
    const m = new Map<ClientClass, number>()
    for (const s of scores) m.set(s.classification, (m.get(s.classification) ?? 0) + 1)
    return m
  }, [scores])

  return (
    <div className="min-h-screen">
      <Header
        title="Client Ranking"
        subtitle="Strategic value and payment reliability per client, combined into one score"
        actions={
          <Link href="/dashboard/invoices/follow-ups"
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-border/80 transition-colors">
            <History className="w-3.5 h-3.5" /> Back to Follow-ups
          </Link>
        }
      />

      <div className="px-4 sm:px-6 lg:px-8 pb-16 max-w-6xl mx-auto">
        {/* Classification summary */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mt-2 mb-6">
          {(Object.keys(CLASS_STYLE) as ClientClass[]).map(c => (
            <div key={c} className="rounded-xl border border-border bg-card px-3 py-2.5">
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${CLASS_STYLE[c]}`}>{c}</span>
              <div className="text-lg font-bold text-foreground mt-1.5">{counts.get(c) ?? 0}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-border mb-4">
          {([
            { id: 'strategic' as const,   label: 'Strategic Score', icon: Award },
            { id: 'reliability' as const, label: 'Payment Reliability', icon: ShieldCheck },
            { id: 'value' as const,       label: 'Business Value', icon: TrendingUp },
          ]).map(t => {
            const Icon = t.icon
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
                  tab === t.id ? 'border-violet-500 text-violet-600 dark:text-violet-300' : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}>
                <Icon className="w-3.5 h-3.5" /> {t.label}
              </button>
            )
          })}
        </div>

        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search client…"
          className="w-full max-w-xs bg-secondary border border-border rounded-lg px-3 py-2 text-xs mb-4 focus:outline-none focus:ring-2 focus:ring-primary/50"
        />

        {/* Table */}
        <div className="rounded-xl border border-border bg-card overflow-hidden overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-secondary/50 text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-3 py-2">Client</th>
                <th className="text-left font-medium px-3 py-2">Class</th>
                {tab === 'strategic' && <th className="text-right font-medium px-3 py-2">Strategic Score</th>}
                {tab !== 'value' && <>
                  <th className="text-right font-medium px-3 py-2">Reliability</th>
                  <th className="text-right font-medium px-3 py-2">Avg Days Late</th>
                  <th className="text-right font-medium px-3 py-2">Promise-Kept</th>
                  <th className="text-right font-medium px-3 py-2">Overdue Rate</th>
                  {showAmounts && <th className="text-right font-medium px-3 py-2">Outstanding</th>}
                </>}
                {tab !== 'reliability' && <>
                  <th className="text-right font-medium px-3 py-2">Value Score</th>
                  {showAmounts && <th className="text-right font-medium px-3 py-2">Lifetime Revenue</th>}
                  <th className="text-right font-medium px-3 py-2">Tasks</th>
                  <th className="text-right font-medium px-3 py-2">Trend</th>
                  <th className="text-right font-medium px-3 py-2">Last Activity</th>
                </>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {sorted.map(s => (
                <tr key={s.clientId} className="hover:bg-secondary/30">
                  <td className="px-3 py-2.5 font-medium text-foreground whitespace-nowrap">{s.clientName}</td>
                  <td className="px-3 py-2.5">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border whitespace-nowrap ${CLASS_STYLE[s.classification]}`}>{s.classification}</span>
                  </td>
                  {tab === 'strategic' && <td className="px-3 py-2.5 text-right font-bold text-foreground">{s.strategicScore}</td>}
                  {tab !== 'value' && <>
                    <td className="px-3 py-2.5 text-right font-semibold text-foreground">{s.reliability.score}</td>
                    <td className="px-3 py-2.5 text-right text-muted-foreground">{fmtDays(s.reliability.avgDaysLate)}</td>
                    <td className="px-3 py-2.5 text-right text-muted-foreground">{s.reliability.promisesTracked ? fmtPct(s.reliability.promiseKeptRate) : '—'}</td>
                    <td className="px-3 py-2.5 text-right text-muted-foreground">{fmtPct(s.reliability.overdueRate)}</td>
                    {showAmounts && <td className="px-3 py-2.5 text-right text-muted-foreground">{fmtINR(s.reliability.outstandingInr)}</td>}
                  </>}
                  {tab !== 'reliability' && <>
                    <td className="px-3 py-2.5 text-right font-semibold text-foreground">{s.value.score}</td>
                    {showAmounts && <td className="px-3 py-2.5 text-right text-muted-foreground">{fmtINR(s.value.totalRevenueInr)}</td>}
                    <td className="px-3 py-2.5 text-right text-muted-foreground">{s.value.taskCount}</td>
                    <td className="px-3 py-2.5 text-right text-muted-foreground">
                      {s.value.revenueTrendPct == null ? '—' : (
                        <span className={s.value.revenueTrendPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                          {s.value.revenueTrendPct >= 0 ? '+' : ''}{s.value.revenueTrendPct}%
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right text-muted-foreground">{fmtDays(s.value.recentActivityDays)}</td>
                  </>}
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr><td colSpan={10} className="px-3 py-10 text-center text-muted-foreground">No clients match.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-muted-foreground/70 mt-3">
          Strategic Score = 60% Business Value + 40% Payment Reliability. Reliability blends payment lateness, promise-keeping, overdue frequency, and follow-up effort.
          Value blends lifetime revenue, completed work, recency, and revenue trend — both scored 0–100 relative to your other clients.
        </p>
      </div>
    </div>
  )
}
