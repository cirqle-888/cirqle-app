'use client'

/**
 * Client Analytics — presentation only.
 *
 * Every number comes from src/lib/analytics/client-series.ts, and the periods
 * from the same finance-engine resolver the company graph uses, so "this
 * quarter" means one thing across the whole app. Nothing is computed inline
 * here; a formula in a component is how two screens start disagreeing.
 */

import { useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts'
import Header from '@/components/layout/header'
import { resolveComparisonPeriods, addDays, type ComparisonMode } from '@/lib/finance/trends'
import {
  buildClientSeries, seriesTotals, rankClients, alignClientSeries, deltaPct,
  isMoneyMetric, METRIC_LABELS,
  type ClientTaskPoint, type ClientMetric, type ClientTotals,
} from '@/lib/analytics/client-series'

const TOOLTIP_STYLE = {
  contentStyle: {
    background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8,
    fontSize: 11, boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
  },
  labelStyle: { color: 'var(--muted-foreground)' },
  wrapperStyle: { zIndex: 50 },
}

/** Distinguishable at a glance, and legible on both themes. */
const COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#ec4899', '#10b981', '#ef4444']
const ALL = '__all__'

const MODES: { key: ComparisonMode; label: string; prev: string }[] = [
  { key: 'week',    label: 'Week',    prev: 'last week' },
  { key: 'month',   label: 'Month',   prev: 'last month' },
  { key: 'quarter', label: 'Quarter', prev: 'last quarter' },
  { key: 'year',    label: 'Year',    prev: 'last year' },
  { key: 'custom',  label: 'Custom',  prev: 'the period before' },
]

const METRICS: ClientMetric[] = ['jobs', 'valueInr', 'revenueInr', 'creatives']

interface Client { id: string; name: string; isActive: boolean }

export default function ClientAnalyticsClient(
  { today, clients, points }: { today: string; clients: Client[]; points: ClientTaskPoint[] },
) {
  const [mode, setMode] = useState<ComparisonMode>('month')
  const [metric, setMetric] = useState<ClientMetric>('revenueInr')
  const [compare, setCompare] = useState(true)
  const [customFrom, setCustomFrom] = useState(addDays(today, -29))
  const [customTo, setCustomTo] = useState(today)
  const [picked, setPicked] = useState<string[]>([ALL])
  const [search, setSearch] = useState('')

  const periods = useMemo(() => resolveComparisonPeriods(
    mode, today,
    mode === 'custom' && customFrom && customTo && customFrom <= customTo
      ? { from: customFrom, to: customTo } : undefined,
  ), [mode, today, customFrom, customTo])

  const nameById = useMemo(
    () => new Map(clients.map(c => [c.id, c.name])), [clients])

  /* Ranked over the CURRENT period, so the list offers whoever matters now
     rather than whoever mattered two years ago. */
  const ranked = useMemo(
    () => rankClients(points, periods.current, nameById),
    [points, periods, nameById])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const inPeriod = new Set(ranked.map(r => r.id))
    const rest = clients.filter(c => !inPeriod.has(c.id))
    const ordered = [...ranked.map(r => ({ id: r.id, name: r.name })), ...rest]
    return q ? ordered.filter(c => c.name.toLowerCase().includes(q)) : ordered
  }, [ranked, clients, search])

  /* Memoised, not derived inline: a fresh array every render makes every
     useMemo below it miss, which on a year of daily buckets is real work. */
  const selected = useMemo(() => (picked.length ? picked : [ALL]), [picked])

  const current = useMemo(() => new Map(selected.map(id =>
    [id, buildClientSeries(points, id === ALL ? null : id, periods.current, periods.granularity)],
  )), [selected, points, periods])

  const previous = useMemo(() => new Map(selected.map(id =>
    [id, buildClientSeries(points, id === ALL ? null : id, periods.previous, periods.granularity)],
  )), [selected, points, periods])

  const rows = useMemo(
    () => alignClientSeries(current, compare ? previous : new Map(), metric),
    [current, previous, compare, metric])

  const summary = useMemo(() => selected.map((id, i) => ({
    id,
    name: id === ALL ? 'All clients' : nameById.get(id) ?? 'Unknown client',
    colour: COLORS[i % COLORS.length],
    now: seriesTotals(current.get(id) ?? []),
    before: seriesTotals(previous.get(id) ?? []),
  })), [selected, current, previous, nameById])

  const modeMeta = MODES.find(m => m.key === mode)!
  const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN')
  const fmt = (n: number) => (isMoneyMetric(metric) ? inr(n) : String(Math.round(n)))
  const cell = (t: ClientTotals, k: ClientMetric) =>
    isMoneyMetric(k) ? inr(t[k]) : String(t[k])

  const toggle = (id: string) => setPicked(prev => {
    if (id === ALL) return prev.includes(ALL) ? prev.filter(p => p !== ALL) : [...prev, ALL]
    return prev.includes(id) ? prev.filter(p => p !== id)
      : prev.length >= COLORS.length ? prev : [...prev, id]
  })

  return (
    <>
      <Header title="Client Analytics" subtitle="Work and money per client, against the period before" />
      <div className="p-4 md:p-6 space-y-4">

        {/* ── Controls ── */}
        <div className="bg-card border border-border rounded-xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] text-muted-foreground">
                {periods.current.from} → {periods.current.to}
                {compare && <> · vs {periods.previous.from} → {periods.previous.to}</>}
                {' · '}{periods.granularity === 'day' ? 'daily' : 'monthly'} buckets
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 bg-secondary rounded-lg p-1">
                {MODES.map(m => (
                  <button key={m.key} onClick={() => setMode(m.key)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${mode === m.key
                      ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                    {m.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1 bg-secondary rounded-lg p-1">
                {METRICS.map(k => (
                  <button key={k} onClick={() => setMetric(k)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${metric === k
                      ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                    {METRIC_LABELS[k]}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
                <input type="checkbox" checked={compare} onChange={e => setCompare(e.target.checked)}
                  className="w-3.5 h-3.5 rounded accent-violet-500" />
                <span className="text-muted-foreground">vs {modeMeta.prev}</span>
              </label>
            </div>
          </div>

          {mode === 'custom' && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <input type="date" value={customFrom} max={customTo} onChange={e => setCustomFrom(e.target.value)}
                className="bg-background border border-border rounded-lg px-2.5 py-1.5" />
              <span className="text-muted-foreground">→</span>
              <input type="date" value={customTo} min={customFrom} max={today} onChange={e => setCustomTo(e.target.value)}
                className="bg-background border border-border rounded-lg px-2.5 py-1.5" />
            </div>
          )}

          {/* ── Who to plot ── */}
          <div className="space-y-2">
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Find a client…"
              className="w-full md:w-64 bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs
                         focus:outline-none focus:ring-2 focus:ring-primary/50" />
            <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
              <button onClick={() => toggle(ALL)}
                className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${selected.includes(ALL)
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:text-foreground'}`}>
                All clients
              </button>
              {visible.map(c => (
                <button key={c.id} onClick={() => toggle(c.id)}
                  className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${picked.includes(c.id)
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:text-foreground'}`}>
                  {c.name}
                </button>
              ))}
              {!visible.length && <span className="text-xs text-muted-foreground py-1">No client matches “{search}”.</span>}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Up to {COLORS.length} at once. Ranked by billable revenue in this period.
            </p>
          </div>
        </div>

        {/* ── Totals, one card per selected client ── */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {summary.map(s => {
            const d = deltaPct(s.now[metric], s.before[metric])
            return (
              <div key={s.id} className="bg-card border border-border rounded-xl p-4">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: s.colour }} />
                  <span className="text-sm font-medium truncate">{s.name}</span>
                </div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-xl font-semibold">{fmt(s.now[metric])}</span>
                  {compare && d !== null && (
                    <span className={`text-xs font-medium ${d >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                      {d >= 0 ? '+' : ''}{d}%
                    </span>
                  )}
                  {compare && d === null && (
                    <span className="text-xs text-muted-foreground">no baseline</span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">{METRIC_LABELS[metric]}</p>
                <dl className="mt-3 grid grid-cols-2 gap-y-1 text-[11px]">
                  <dt className="text-muted-foreground">Jobs</dt><dd className="text-right">{s.now.jobs}</dd>
                  <dt className="text-muted-foreground">Job value</dt><dd className="text-right">{inr(s.now.valueInr)}</dd>
                  <dt className="text-muted-foreground">Billable</dt><dd className="text-right">{inr(s.now.revenueInr)}</dd>
                  <dt className="text-muted-foreground">Creatives</dt><dd className="text-right">{s.now.creatives}</dd>
                </dl>
              </div>
            )
          })}
        </div>

        {/* ── The chart ── */}
        <div className="bg-card border border-border rounded-xl p-4">
          <h3 className="text-sm font-semibold mb-3">
            {METRIC_LABELS[metric]} · {modeMeta.label.toLowerCase()}
            {compare && <span className="text-muted-foreground font-normal"> — dashed is {modeMeta.prev}</span>}
          </h3>
          <div className="h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} minTickGap={16} />
                <YAxis tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} width={56}
                  tickFormatter={(v: number) => isMoneyMetric(metric)
                    ? '₹' + (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)) : String(v)} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v: unknown) => fmt(Number(v ?? 0))} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {summary.map(s => (
                  <Line key={`c_${s.id}`} type="monotone" dataKey={`c_${s.id}`} name={s.name}
                    stroke={s.colour} strokeWidth={2} dot={false} connectNulls />
                ))}
                {compare && summary.map(s => (
                  <Line key={`p_${s.id}`} type="monotone" dataKey={`p_${s.id}`} name={`${s.name} (prev)`}
                    stroke={s.colour} strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls opacity={0.55} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* ── The same period as figures, for everyone who worked in it ── */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <h3 className="text-sm font-semibold px-4 pt-4">Every client in this period</h3>
          <div className="overflow-x-auto mt-3">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground border-b border-border">
                <tr>
                  <th className="text-left font-medium px-4 py-2">Client</th>
                  <th className="text-right font-medium px-4 py-2">Jobs</th>
                  <th className="text-right font-medium px-4 py-2">Job value</th>
                  <th className="text-right font-medium px-4 py-2">Billable</th>
                  <th className="text-right font-medium px-4 py-2">Creatives</th>
                  <th className="text-right font-medium px-4 py-2">vs {modeMeta.prev}</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map(r => {
                  const now = seriesTotals(buildClientSeries(points, r.id, periods.current, periods.granularity))
                  const before = seriesTotals(buildClientSeries(points, r.id, periods.previous, periods.granularity))
                  const d = deltaPct(now[metric], before[metric])
                  return (
                    <tr key={r.id} className="border-b border-border/50 hover:bg-secondary/40">
                      <td className="px-4 py-2">
                        <button onClick={() => toggle(r.id)} className="hover:underline text-left">{r.name}</button>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{cell(now, 'jobs')}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{cell(now, 'valueInr')}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{cell(now, 'revenueInr')}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{cell(now, 'creatives')}</td>
                      <td className={`px-4 py-2 text-right tabular-nums ${d == null ? 'text-muted-foreground'
                        : d >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                        {d == null ? '—' : `${d >= 0 ? '+' : ''}${d}%`}
                      </td>
                    </tr>
                  )
                })}
                {!ranked.length && (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                    No client did any work in this period.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  )
}
