'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { History, Search, ExternalLink, Users, BarChart3 } from 'lucide-react'
import { usePrivacy } from '@/contexts/privacy-context'
import { formatDate } from '@/lib/utils/format-date'

interface ActivityRow {
  id:                 string
  note:               string | null
  outcome:            string | null
  promised_date:      string | null
  next_followup_date: string | null
  created_at:         string
  employee:           { cqid: string; name: string } | null
  invoice:            { id: string; invoice_number: string; status: string } | null
  client:             { id: string; name: string } | null
}

const OUTCOME_LABEL: Record<string, string> = {
  promised: 'Promised to pay', partial_promised: 'Promised partial', callback: 'Will call back',
  no_response: 'No response', disputed: 'Disputed / query', sent: 'Reminder sent', other: 'Other',
}
function outcomeColor(o: string | null): string {
  switch (o) {
    case 'promised':         return 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-400'
    case 'partial_promised': return 'bg-teal-500/15 text-teal-700 border-teal-500/30 dark:text-teal-400'
    case 'callback':         return 'bg-blue-500/15 text-blue-700 border-blue-500/30 dark:text-blue-400'
    case 'no_response':      return 'bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-400'
    case 'disputed':         return 'bg-red-500/15 text-red-700 border-red-500/30 dark:text-red-400'
    case 'sent':              return 'bg-violet-500/15 text-violet-700 border-violet-500/30 dark:text-violet-400'
    default:                 return 'bg-gray-500/15 text-gray-700 border-gray-500/30 dark:text-gray-400'
  }
}
const fmtDateTime = (s: string) => {
  const d = new Date(s)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
const fmtDate = (s: string | null) => (s ? formatDate(s) : null)

export default function ActivityClient({ rows, setupNeeded }: { rows: ActivityRow[]; setupNeeded: boolean }) {
  // Actor names respect the global privacy lock — real name only when unlocked, else CQID.
  const { dn } = usePrivacy()
  const [search, setSearch]     = useState('')
  const [employee, setEmployee] = useState('')
  const [outcome, setOutcome]   = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate]     = useState('')

  const employees = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of rows) if (r.employee) m.set(r.employee.cqid, r.employee.name)
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [rows])

  const filtered = useMemo(() => rows.filter(r => {
    if (employee && r.employee?.cqid !== employee) return false
    if (outcome && r.outcome !== outcome) return false
    if (fromDate && r.created_at < fromDate) return false
    if (toDate && r.created_at > `${toDate}T23:59:59`) return false
    if (search) {
      const q = search.toLowerCase()
      const hay = `${r.invoice?.invoice_number ?? ''} ${r.client?.name ?? ''} ${r.note ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  }), [rows, employee, outcome, fromDate, toDate, search])

  // ── Summary stats (computed over the unfiltered dataset — the whole point
  // of this page is the big-picture activity, filters just narrow the table) ──
  const stats = useMemo(() => {
    const now = Date.now()
    const day = 86400000
    const last7  = rows.filter(r => now - new Date(r.created_at).getTime() <= 7 * day).length
    const last30 = rows.filter(r => now - new Date(r.created_at).getTime() <= 30 * day).length
    const byOutcome = new Map<string, number>()
    for (const r of rows) byOutcome.set(r.outcome || 'other', (byOutcome.get(r.outcome || 'other') ?? 0) + 1)
    const byEmployee = new Map<string, { cqid: string; name: string; count: number }>()
    for (const r of rows) {
      if (!r.employee) continue
      const e = byEmployee.get(r.employee.cqid) ?? { cqid: r.employee.cqid, name: r.employee.name, count: 0 }
      e.count++
      byEmployee.set(r.employee.cqid, e)
    }
    const byClient = new Map<string, { name: string; count: number }>()
    for (const r of rows) {
      if (!r.client) continue
      const e = byClient.get(r.client.id) ?? { name: r.client.name, count: 0 }
      e.count++
      byClient.set(r.client.id, e)
    }
    return {
      total: rows.length, last7, last30,
      byOutcome: [...byOutcome.entries()].sort((a, b) => b[1] - a[1]),
      topEmployees: [...byEmployee.values()].sort((a, b) => b.count - a.count).slice(0, 5),
      topClients: [...byClient.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    }
  }, [rows])

  return (
    <div className="min-h-screen">
      <Header
        title="Follow-up Activity Log"
        subtitle="Every follow-up logged across all invoices — who chased what, and what clients said"
        actions={
          <Link href="/dashboard/invoices/follow-ups"
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-border/80 transition-colors">
            <History className="w-3.5 h-3.5" /> Back to Follow-ups
          </Link>
        }
      />

      <div className="px-4 sm:px-6 lg:px-8 pb-16 max-w-6xl mx-auto">
        {setupNeeded && (
          <div className="mt-2 mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
            Follow-up history is unavailable until the database migration runs.
          </div>
        )}

        {/* Summary KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-2 mb-4">
          <div className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="text-[11px] text-muted-foreground mb-1">Total follow-ups logged</div>
            <div className="text-lg font-bold text-foreground">{stats.total}</div>
          </div>
          <div className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="text-[11px] text-muted-foreground mb-1">Last 7 days</div>
            <div className="text-lg font-bold text-foreground">{stats.last7}</div>
          </div>
          <div className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="text-[11px] text-muted-foreground mb-1">Last 30 days</div>
            <div className="text-lg font-bold text-foreground">{stats.last30}</div>
          </div>
        </div>

        {/* Breakdown panels */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
              <BarChart3 className="w-3.5 h-3.5" /> By Outcome
            </h3>
            <div className="space-y-1.5">
              {stats.byOutcome.map(([o, count]) => (
                <div key={o} className="flex items-center justify-between text-xs">
                  <span className={`px-1.5 py-0.5 rounded-full border ${outcomeColor(o)}`}>{OUTCOME_LABEL[o] || o}</span>
                  <span className="font-semibold text-foreground">{count}</span>
                </div>
              ))}
              {stats.byOutcome.length === 0 && <p className="text-xs text-muted-foreground">No data yet</p>}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" /> Most Active (by employee)
            </h3>
            <div className="space-y-1.5">
              {stats.topEmployees.map(e => (
                <div key={e.cqid} className="flex items-center justify-between text-xs">
                  <span className="text-foreground">{dn(e)}</span>
                  <span className="font-semibold text-muted-foreground">{e.count}</span>
                </div>
              ))}
              {stats.topEmployees.length === 0 && <p className="text-xs text-muted-foreground">No data yet</p>}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" /> Most Chased Clients
            </h3>
            <div className="space-y-1.5">
              {stats.topClients.map(c => (
                <div key={c.name} className="flex items-center justify-between text-xs">
                  <span className="text-foreground">{c.name}</span>
                  <span className="font-semibold text-muted-foreground">{c.count}</span>
                </div>
              ))}
              {stats.topClients.length === 0 && <p className="text-xs text-muted-foreground">No data yet</p>}
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search invoice, client, or note…"
              className="w-full bg-secondary border border-border rounded-lg pl-8 pr-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <select value={employee} onChange={e => setEmployee(e.target.value)}
            className="bg-secondary border border-border rounded-lg px-2.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50">
            <option value="">All employees</option>
            {employees.map(([cqid, name]) => <option key={cqid} value={cqid}>{dn({ cqid, name })}</option>)}
          </select>
          <select value={outcome} onChange={e => setOutcome(e.target.value)}
            className="bg-secondary border border-border rounded-lg px-2.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50">
            <option value="">All outcomes</option>
            {Object.entries(OUTCOME_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
            className="bg-secondary border border-border rounded-lg px-2.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50" />
          <span className="text-xs text-muted-foreground">to</span>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
            className="bg-secondary border border-border rounded-lg px-2.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50" />
          {(search || employee || outcome || fromDate || toDate) && (
            <button onClick={() => { setSearch(''); setEmployee(''); setOutcome(''); setFromDate(''); setToDate('') }}
              className="text-xs text-muted-foreground hover:text-foreground">Clear</button>
          )}
        </div>

        {/* Table */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-4 py-2 border-b border-border text-[11px] text-muted-foreground">{filtered.length} of {rows.length} entries</div>
          <div className="divide-y divide-border/40">
            {filtered.map(r => {
              const promised = fmtDate(r.promised_date)
              const next = fmtDate(r.next_followup_date)
              return (
                <div key={r.id} className="px-4 py-3 flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4">
                  <div className="text-[11px] text-muted-foreground shrink-0 sm:w-36">{fmtDateTime(r.created_at)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      {r.invoice && (
                        <Link href="/dashboard/invoices" className="text-xs font-semibold text-foreground hover:text-primary flex items-center gap-1">
                          {r.invoice.invoice_number} <ExternalLink className="w-2.5 h-2.5" />
                        </Link>
                      )}
                      {r.client && <span className="text-xs text-muted-foreground">{r.client.name}</span>}
                      {r.outcome && <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${outcomeColor(r.outcome)}`}>{OUTCOME_LABEL[r.outcome] || r.outcome}</span>}
                      {r.employee && <span className="text-[10px] text-muted-foreground/70">· {dn(r.employee)}</span>}
                    </div>
                    {r.note && <p className="text-xs text-foreground/80">{r.note}</p>}
                    <div className="flex items-center gap-2 mt-1">
                      {promised && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-700 dark:text-blue-400 border border-blue-500/20">Promised {promised}</span>}
                      {next && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">Next chase {next}</span>}
                    </div>
                  </div>
                </div>
              )
            })}
            {filtered.length === 0 && (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">No follow-ups match these filters.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
