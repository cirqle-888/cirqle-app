'use client'

/**
 * Client Analytics — presentation only.
 *
 * Every number comes from src/lib/analytics/client-series.ts, and the periods
 * from the same finance-engine resolver the company graph uses, so "this
 * quarter" means one thing across the whole app. Nothing is computed inline
 * here; a formula in a component is how two screens start disagreeing.
 */

import { Fragment, useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts'
import Header from '@/components/layout/header'
import { resolveComparisonPeriods, addDays, rangeDays, type ComparisonMode } from '@/lib/finance/trends'
import {
  buildClientSeries, seriesTotals, rankClients, alignClientSeries, deltaPct,
  isMoneyMetric, likeForLikePrevious, METRIC_LABELS, METRIC_SHORT,
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

const MODES: { key: ComparisonMode; label: string; prev: string; prevShort: string }[] = [
  { key: 'week',    label: 'Week',    prev: 'last week',         prevShort: 'Last week' },
  { key: 'month',   label: 'Month',   prev: 'last month',        prevShort: 'Last month' },
  { key: 'quarter', label: 'Quarter', prev: 'last quarter',      prevShort: 'Last qtr' },
  { key: 'year',    label: 'Year',    prev: 'last year',         prevShort: 'Last year' },
  { key: 'custom',  label: 'Custom',  prev: 'the period before', prevShort: 'Before' },
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

  /* Like for like. resolveComparisonPeriods clamps the CURRENT period to
     today but leaves the previous one whole, so on the 21st "this month"
     is 21 days and "last month" is 31 — and the difference reads as a
     collapse. Everything below compares equal spans. */
  const prevPeriod = useMemo(
    () => likeForLikePrevious(periods.current, periods.previous), [periods])

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
    [id, buildClientSeries(points, id === ALL ? null : id, prevPeriod, periods.granularity)],
  )), [selected, points, prevPeriod, periods])

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

  /* Built once per period, not twice per client per render. A custom year
     over sixty clients is 43,000 bucket objects, and it was doing that on
     every checkbox tick. */
  const table = useMemo(() => ranked.map(r => ({
    id: r.id,
    name: r.name,
    now: seriesTotals(buildClientSeries(points, r.id, periods.current, periods.granularity)),
    before: seriesTotals(buildClientSeries(points, r.id, prevPeriod, periods.granularity)),
  })), [ranked, points, periods, prevPeriod])

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
                {compare && <> · vs {prevPeriod.from} → {prevPeriod.to}</>}
                {compare && prevPeriod.to !== periods.previous.to && (
                  <> <span className="text-amber-500">(same {rangeDays(prevPeriod)} days)</span></>
                )}
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
                {/* All four figures, this period against the one before.
                    The headline above answers one metric; a client's month is
                    rarely one number — jobs can fall while value rises. */}
                <dl className={`mt-3 grid gap-x-3 gap-y-1 text-[11px] ${compare ? 'grid-cols-3' : 'grid-cols-2'}`}>
                  {/* Empty, but NOT sr-only: that is position:absolute, which
                      takes the cell out of the grid and shifts every row one
                      column left. */}
                  <dt aria-hidden="true" />
                  <dd className="text-right text-muted-foreground font-medium">{modeMeta.label}</dd>
                  {compare && <dd className="text-right text-muted-foreground font-medium">{modeMeta.prevShort}</dd>}
                  {METRICS.map(k => {
                    const d = deltaPct(s.now[k], s.before[k])
                    return (
                      <Fragment key={k}>
                        <dt className="text-muted-foreground">{METRIC_SHORT[k]}</dt>
                        <dd className="text-right tabular-nums">{cell(s.now, k)}</dd>
                        {compare && (
                          <dd className="text-right tabular-nums text-muted-foreground"
                            title={d == null ? 'nothing to compare against' : `${d >= 0 ? '+' : ''}${d}%`}>
                            {cell(s.before, k)}
                          </dd>
                        )}
                      </Fragment>
                    )
                  })}
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
              {/* Each measure becomes a PAIR of columns when comparing, under
                  one grouped heading — the previous figure beside the current
                  one rather than a bare percentage that hides both. */}
              <thead className="text-muted-foreground border-b border-border">
                <tr>
                  <th rowSpan={compare ? 2 : 1} className="text-left font-medium px-4 py-2 align-bottom">Client</th>
                  {METRICS.map(k => (
                    <th key={k} colSpan={compare ? 2 : 1}
                      className={`text-right font-medium px-4 py-2 ${compare ? 'border-l border-border/40' : ''}`}>
                      {METRIC_SHORT[k]}
                    </th>
                  ))}
                  <th rowSpan={compare ? 2 : 1}
                    className="text-right font-medium px-4 py-2 align-bottom border-l border-border/40">
                    vs {modeMeta.prev}
                  </th>
                </tr>
                {compare && (
                  <tr className="text-[10px]">
                    {METRICS.map(k => (
                      <Fragment key={k}>
                        <th className="text-right font-normal px-4 pb-2 border-l border-border/40">{modeMeta.label}</th>
                        <th className="text-right font-normal px-4 pb-2 opacity-70">{modeMeta.prevShort}</th>
                      </Fragment>
                    ))}
                  </tr>
                )}
              </thead>
              <tbody>
                {table.map(r => {
                  const d = deltaPct(r.now[metric], r.before[metric])
                  return (
                    <tr key={r.id} className="border-b border-border/50 hover:bg-secondary/40">
                      <td className="px-4 py-2">
                        <button onClick={() => toggle(r.id)} className="hover:underline text-left">{r.name}</button>
                      </td>
                      {METRICS.map(k => (
                        <Fragment key={k}>
                          <td className={`px-4 py-2 text-right tabular-nums ${compare ? 'border-l border-border/40' : ''}`}>
                            {cell(r.now, k)}
                          </td>
                          {compare && (
                            <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                              {cell(r.before, k)}
                            </td>
                          )}
                        </Fragment>
                      ))}
                      <td className={`px-4 py-2 text-right tabular-nums border-l border-border/40 ${d == null
                        ? 'text-muted-foreground' : d >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                        {d == null ? '—' : `${d >= 0 ? '+' : ''}${d}%`}
                      </td>
                    </tr>
                  )
                })}
                {!table.length && (
                  <tr><td colSpan={compare ? 10 : 6} className="px-4 py-6 text-center text-muted-foreground">
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
