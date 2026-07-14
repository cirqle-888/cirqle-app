'use client'

// Main dashboard trend graph — jobs received, cash inflow/outflow and the
// running bank balance on one chart, with per-series show/hide checkboxes and
// a period-over-period comparison overlay (dashed = previous period).
//
// Loaded lazily via next/dynamic from dashboard-utils.tsx (recharts is ~95 KB
// min+gz), same pattern as the other dashboard charts in _charts.tsx.
// All math lives in the Finance Engine (src/lib/finance/trends.ts, pure +
// unit-tested); this file is presentation only.

import { useMemo, useState } from 'react'
import {
  ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import {
  resolveComparisonPeriods, buildTrendSeries, alignComparison, seriesTotals, pctChange,
  addDays, type ComparisonMode, type TrendCashPoint, type TrendTaskPoint,
} from '@/lib/finance/trends'

const TOOLTIP_STYLE = {
  contentStyle: { background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontSize: 11 },
  labelStyle: { color: '#9ca3af' },
  wrapperStyle: { zIndex: 50 },
}

type SeriesKey = 'jobs' | 'inflowInr' | 'outflowInr' | 'balanceInr'

const SERIES: { key: SeriesKey; label: string; color: string; axis: 'inr' | 'cnt'; money: boolean }[] = [
  { key: 'jobs',       label: 'Jobs Received', color: '#a855f7', axis: 'cnt', money: false },
  { key: 'inflowInr',  label: 'Inflow',        color: '#34d399', axis: 'inr', money: true },
  { key: 'outflowInr', label: 'Outflow',       color: '#f87171', axis: 'inr', money: true },
  { key: 'balanceInr', label: 'Bank Balance',  color: '#60a5fa', axis: 'inr', money: true },
]

const MODES: { key: ComparisonMode; label: string; prevLabel: string }[] = [
  { key: 'week',    label: 'Week',    prevLabel: 'last week' },
  { key: 'month',   label: 'Month',   prevLabel: 'last month' },
  { key: 'quarter', label: 'Quarter', prevLabel: 'last quarter' },
  { key: 'year',    label: 'Year',    prevLabel: 'last year' },
  { key: 'custom',  label: 'Custom',  prevLabel: 'previous period of same length' },
]

export function DashboardTrendGraph({ cashbook, tasks, fmt }: {
  cashbook: { type: string; amount_inr?: number; entry_date: string }[]
  tasks: { task_date: string | null }[]
  fmt: (n: number) => string
}) {
  const today = new Date().toISOString().slice(0, 10)
  const [mode, setMode] = useState<ComparisonMode>('month')
  const [customFrom, setCustomFrom] = useState(addDays(today, -29))
  const [customTo, setCustomTo] = useState(today)
  const [compare, setCompare] = useState(true)
  const [visible, setVisible] = useState<Record<SeriesKey, boolean>>({
    jobs: true, inflowInr: true, outflowInr: true, balanceInr: true,
  })

  // Normalize once — the raw props come straight from the dashboard's existing
  // fetches (all-time cashbook, 36-month tasks); no extra queries needed.
  const inputs = useMemo(() => ({
    cash: cashbook
      .filter(e => e.entry_date && (e.type === 'inflow' || e.type === 'outflow'))
      .map(e => ({ date: e.entry_date, type: e.type, amountInr: Number(e.amount_inr || 0) })) as TrendCashPoint[],
    tasks: tasks.filter(t => t.task_date).map(t => ({ date: t.task_date! })) as TrendTaskPoint[],
  }), [cashbook, tasks])

  const { rows, curTotals, prevTotals, periods } = useMemo(() => {
    const periods = resolveComparisonPeriods(
      mode, today,
      mode === 'custom' && customFrom && customTo && customFrom <= customTo
        ? { from: customFrom, to: customTo } : undefined,
    )
    const cur = buildTrendSeries(inputs, periods.current, periods.granularity)
    const prev = compare ? buildTrendSeries(inputs, periods.previous, periods.granularity) : []
    return {
      rows: alignComparison(cur, prev),
      curTotals: seriesTotals(cur),
      prevTotals: compare ? seriesTotals(prev) : null,
      periods,
    }
  }, [inputs, mode, today, customFrom, customTo, compare])

  const anyMoney = SERIES.some(s => s.money && visible[s.key])
  const modeMeta = MODES.find(m => m.key === mode)!

  const totalOf = (t: ReturnType<typeof seriesTotals>, key: SeriesKey) =>
    key === 'jobs' ? t.jobs : key === 'inflowInr' ? t.inflowInr : key === 'outflowInr' ? t.outflowInr : t.endBalanceInr

  return (
    <section className="bg-card border border-border rounded-xl p-4 space-y-4">
      {/* ── Header: title + period mode + compare toggle ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Business Trends</h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {periods.current.from} → {periods.current.to}
            {compare && <> · vs {periods.previous.from} → {periods.previous.to}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 bg-secondary rounded-lg p-1">
            {MODES.map(m => (
              <button
                key={m.key}
                onClick={() => setMode(m.key)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${mode === m.key
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={compare}
              onChange={e => setCompare(e.target.checked)}
              className="w-3.5 h-3.5 rounded accent-violet-500"
            />
            <span className="text-muted-foreground">vs {modeMeta.prevLabel}</span>
          </label>
        </div>
      </div>

      {/* ── Custom range inputs ── */}
      {mode === 'custom' && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input type="date" value={customFrom} max={customTo} onChange={e => setCustomFrom(e.target.value)}
            className="bg-background border border-border rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/50" />
          <span className="text-muted-foreground">→</span>
          <input type="date" value={customTo} min={customFrom} max={today} onChange={e => setCustomTo(e.target.value)}
            className="bg-background border border-border rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/50" />
          <span className="text-muted-foreground">
            compared with the {Math.max(1, rows.length)} {periods.granularity === 'day' ? 'days' : 'months'} before it
          </span>
        </div>
      )}

      {/* ── Series checkboxes + current-vs-previous delta chips ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {SERIES.map(s => {
          const cur = totalOf(curTotals, s.key)
          const prev = prevTotals ? totalOf(prevTotals, s.key) : null
          const pct = prev != null ? pctChange(cur, prev) : null
          // For outflow, growth is bad — invert the tint.
          const good = pct != null && (s.key === 'outflowInr' ? pct <= 0 : pct >= 0)
          return (
            <label
              key={s.key}
              className={`rounded-lg border px-3 py-2 cursor-pointer select-none transition-colors ${visible[s.key]
                ? 'border-border bg-foreground/[0.03]'
                : 'border-border/40 opacity-50 hover:opacity-80'}`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={visible[s.key]}
                  onChange={e => setVisible(v => ({ ...v, [s.key]: e.target.checked }))}
                  className="w-3.5 h-3.5 rounded"
                  style={{ accentColor: s.color }}
                />
                <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} />
                <span className="text-[11px] text-muted-foreground truncate">{s.label}</span>
              </div>
              <div className="mt-1 flex items-baseline gap-2 pl-[22px]">
                <span className="text-sm font-semibold tabular-nums">
                  {s.money ? fmt(cur) : cur.toLocaleString('en-IN')}
                </span>
                {pct != null && (
                  <span className={`text-[10px] font-medium ${good ? 'text-emerald-500' : 'text-red-500'}`}>
                    {pct > 0 ? '+' : ''}{pct}%
                  </span>
                )}
                {prev != null && (
                  <span className="text-[10px] text-muted-foreground">
                    prev {s.money ? fmt(prev) : prev.toLocaleString('en-IN')}
                  </span>
                )}
              </div>
            </label>
          )
        })}
      </div>

      {/* ── The graph ── */}
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={rows} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false}
            interval="preserveStartEnd" minTickGap={24}
          />
          <YAxis
            yAxisId="inr" hide={!anyMoney}
            tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false}
            tickFormatter={v => fmt(v)} width={54}
          />
          <YAxis
            yAxisId="cnt" orientation="right" hide={!visible.jobs}
            tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false}
            allowDecimals={false} width={30}
          />
          <Tooltip
            {...TOOLTIP_STYLE}
            formatter={(value: any, name: any) => {
              const isPrev = String(name).startsWith('prev:')
              const key = (isPrev ? String(name).slice(5) : String(name)) as SeriesKey
              const meta = SERIES.find(s => s.key === key)
              const formatted = meta?.money ? fmt(Number(value)) : Number(value).toLocaleString('en-IN')
              return [formatted, `${meta?.label ?? name}${isPrev ? ' (prev)' : ''}`]
            }}
            labelFormatter={(label: any, payload: any) => {
              const prevLabel = payload?.[0]?.payload?.prevLabel
              return compare && prevLabel ? `${label} · prev: ${prevLabel}` : label
            }}
          />
          {SERIES.filter(s => visible[s.key]).map(s => (
            <Line
              key={s.key} yAxisId={s.axis} type="monotone"
              dataKey={s.key} name={s.key}
              stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 3 }}
              connectNulls
            />
          ))}
          {compare && SERIES.filter(s => visible[s.key]).map(s => (
            <Line
              key={`prev_${s.key}`} yAxisId={s.axis} type="monotone"
              dataKey={`prev_${s.key}`} name={`prev:${s.key}`}
              stroke={s.color} strokeWidth={1.5} strokeDasharray="5 4" strokeOpacity={0.45}
              dot={false} activeDot={{ r: 2 }} connectNulls
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
      <p className="text-[10px] text-muted-foreground -mt-2">
        Solid = current period · dashed = previous period, aligned by {periods.granularity === 'day' ? 'day' : 'month'} of period.
        Bank balance is the all-time running total; jobs use the right axis.
      </p>
    </section>
  )
}
