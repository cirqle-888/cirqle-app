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

// Theme-aware via CSS vars — the previous hardcoded dark values made the grid
// invisible and the tooltip permanently dark on the light theme.
const TOOLTIP_STYLE = {
  contentStyle: {
    background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8,
    fontSize: 11, boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
  },
  labelStyle: { color: 'var(--muted-foreground)' },
  wrapperStyle: { zIndex: 50 },
}
const AXIS_TICK = { fontSize: 10, fill: 'var(--muted-foreground)' }
const GRID_PROPS = { stroke: 'var(--border)', strokeOpacity: 0.6, vertical: false }

type SeriesKey = 'jobs' | 'inflowInr' | 'outflowInr' | 'balanceInr'
/** What a series can actually plot. Jobs plots either its count or its ₹ value. */
type PlotKey = SeriesKey | 'jobValueInr'

// Palette validated for both themes (dataviz six-checks: lightness band,
// chroma, CVD separation, ≥3:1 contrast on light AND dark surfaces).
//
// FOUR colors, deliberately. Job value rides the EXISTING jobs series via the
// #/₹ toggle rather than becoming a fifth line: at 4 series (8 lines with the
// comparison overlay) this palette already fails the all-pairs CVD check —
// #2563eb↔#8b5cf6 is ΔE 2.3 protan / 12.7 normal, below the 15 floor — and
// every candidate 5th hue made it worse. Faceting beats adding a series.
const SERIES: { key: SeriesKey; label: string; color: string; money: boolean }[] = [
  { key: 'jobs',       label: 'Jobs Received', color: '#8b5cf6', money: false },
  { key: 'inflowInr',  label: 'Inflow',        color: '#059669', money: true },
  { key: 'outflowInr', label: 'Outflow',       color: '#dc2626', money: true },
  { key: 'balanceInr', label: 'Bank Balance',  color: '#2563eb', money: true },
]
const JOBS_COLOR = SERIES[0].color

/** Tooltip/axis metadata by PLOT key — jobValueInr is not a SERIES row. */
const PLOT_META: Record<PlotKey, { label: string; money: boolean }> = {
  jobs:        { label: 'Jobs Received', money: false },
  jobValueInr: { label: 'Job Value',     money: true },
  inflowInr:   { label: 'Inflow',        money: true },
  outflowInr:  { label: 'Outflow',       money: true },
  balanceInr:  { label: 'Bank Balance',  money: true },
}
/** Keys that get %-of-peak rescaled in the combined view. */
const SCALED_KEYS: PlotKey[] = ['jobs', 'jobValueInr', 'inflowInr', 'outflowInr', 'balanceInr']

const MODES: { key: ComparisonMode; label: string; prevLabel: string }[] = [
  { key: 'week',    label: 'Week',    prevLabel: 'last week' },
  { key: 'month',   label: 'Month',   prevLabel: 'last month' },
  { key: 'quarter', label: 'Quarter', prevLabel: 'last quarter' },
  { key: 'year',    label: 'Year',    prevLabel: 'last year' },
  { key: 'custom',  label: 'Custom',  prevLabel: 'previous period of same length' },
]

export function DashboardTrendGraph({ cashbook, tasks, fmt }: {
  cashbook: { type: string; amount_inr?: number; entry_date: string }[]
  tasks: { task_date: string | null; billing_amount_inr?: number | null }[]
  fmt: (n: number) => string
}) {
  const today = new Date().toISOString().slice(0, 10)
  const [mode, setMode] = useState<ComparisonMode>('month')
  const [customFrom, setCustomFrom] = useState(addDays(today, -29))
  const [customTo, setCustomTo] = useState(today)
  const [compare, setCompare] = useState(true)
  // 'combined' = every wave on ONE plot, each series scaled to % of its own
  // period peak (₹ and job counts can't share a raw axis without a misleading
  // dual scale — tooltips still show actual values). 'split' = ₹ pane + jobs pane.
  const [layout, setLayout] = useState<'combined' | 'split'>('combined')
  const [visible, setVisible] = useState<Record<SeriesKey, boolean>>({
    jobs: true, inflowInr: true, outflowInr: true, balanceInr: true,
  })
  // What the jobs series PLOTS. Both numbers are always shown in its chip; this
  // only decides which one gets a line, so the chart never gains a 5th series.
  const [jobsMetric, setJobsMetric] = useState<'count' | 'value'>('count')
  const jobsIsValue = jobsMetric === 'value'

  // Normalize once — the raw props come straight from the dashboard's existing
  // fetches (all-time cashbook, 36-month tasks); no extra queries needed.
  const inputs = useMemo(() => ({
    cash: cashbook
      .filter(e => e.entry_date && (e.type === 'inflow' || e.type === 'outflow'))
      .map(e => ({ date: e.entry_date, type: e.type, amountInr: Number(e.amount_inr || 0) })) as TrendCashPoint[],
    // billing_amount_inr is already the task TOTAL (never a unit price) — every
    // other dashboard aggregate sums it raw, so "Job Value" here reconciles
    // with Total Billed on the same screen.
    tasks: tasks.filter(t => t.task_date).map(t => ({
      date: t.task_date!, valueInr: Number(t.billing_amount_inr) || 0,
    })) as TrendTaskPoint[],
  }), [cashbook, tasks])

  const { rows, curTotals, prevTotals, prevTruncated, periods } = useMemo(() => {
    const periods = resolveComparisonPeriods(
      mode, today,
      mode === 'custom' && customFrom && customTo && customFrom <= customTo
        ? { from: customFrom, to: customTo } : undefined,
    )
    const cur = buildTrendSeries(inputs, periods.current, periods.granularity)
    const prev = compare ? buildTrendSeries(inputs, periods.previous, periods.granularity) : []
    // The current period is clamped to today, so mid-period it's shorter than
    // the previous one. Truncate BOTH the chart rows and the comparison totals
    // to the elapsed length: the x-axis never runs past today (no phantom
    // dates from the previous period), and the delta chips compare the same
    // number of days/months (period-to-date), not 3 days vs a full week.
    const prevToDate = prev.slice(0, Math.max(cur.length, 1))
    return {
      rows: alignComparison(cur, prevToDate).slice(0, Math.max(cur.length, 1)),
      curTotals: seriesTotals(cur),
      prevTotals: compare ? seriesTotals(prevToDate) : null,
      prevTruncated: compare && prev.length > cur.length,
      periods,
    }
  }, [inputs, mode, today, customFrom, customTo, compare])

  // Combined view: rescale every series to % of its own period peak (current
  // and previous share the series' max so their waves stay comparable). The
  // raw values ride along under raw_* keys for the tooltip.
  const combinedRows = useMemo(() => {
    if (layout !== 'combined') return rows
    const maxes = Object.fromEntries(SCALED_KEYS.map(k => [
      k,
      Math.max(1e-9, ...rows.flatMap(r => [
        Math.abs((r as any)[k] ?? 0),
        Math.abs((r as any)[`prev_${k}`] ?? 0),
      ])),
    ]))
    const pct = (v: number, key: PlotKey) => Math.round((v / maxes[key]) * 1000) / 10
    return rows.map(r => {
      const o = { ...r } as typeof r & Record<string, unknown>
      for (const k of SCALED_KEYS) {
        const cur = (r as any)[k], prev = (r as any)[`prev_${k}`]
        o[`raw_${k}`] = cur
        o[`raw_prev_${k}`] = prev
        if (cur != null) (o as any)[k] = pct(cur, k)
        if (prev != null) (o as any)[`prev_${k}`] = pct(prev, k)
      }
      return o
    })
  }, [rows, layout])

  // Jobs plots either its count or its ₹ value; every other series is fixed.
  const plotKeyOf = (k: SeriesKey): PlotKey => (k === 'jobs' && jobsIsValue ? 'jobValueInr' : k)
  const isMoneyKey = (k: SeriesKey) => PLOT_META[plotKeyOf(k)].money

  const anyMoney = SERIES.some(s => isMoneyKey(s.key) && visible[s.key])
  const anyVisible = SERIES.some(s => visible[s.key])
  // The count pane only exists while jobs is plotting a count.
  const showJobsPane = visible.jobs && !jobsIsValue
  const modeMeta = MODES.find(m => m.key === mode)!

  const totalOf = (t: ReturnType<typeof seriesTotals>, key: PlotKey) =>
    key === 'jobs' ? t.jobs
      : key === 'jobValueInr' ? t.jobValueInr
      : key === 'inflowInr' ? t.inflowInr
      : key === 'outflowInr' ? t.outflowInr : t.endBalanceInr

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
          <div className="flex items-center gap-1 bg-secondary rounded-lg p-1">
            {([['combined', 'Combined'], ['split', 'Split']] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setLayout(key)}
                title={key === 'combined'
                  ? 'All waves on one plot — each series scaled to % of its own period peak'
                  : 'Separate panes: ₹ series on top, job counts below'}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${layout === key
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'}`}
              >
                {label}
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
          // Jobs carries a second figure: the ₹ value of those same jobs. Shown
          // ALWAYS, independent of which one the line is plotting — the whole
          // point is that "46 jobs, down 19%" means little without knowing
          // whether those 46 were worth more or less than the 57 before them.
          const isJobs = s.key === 'jobs'
          const curVal = isJobs ? totalOf(curTotals, 'jobValueInr') : 0
          const prevVal = isJobs && prevTotals ? totalOf(prevTotals, 'jobValueInr') : null
          const pctVal = prevVal != null ? pctChange(curVal, prevVal) : null
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
                {isJobs && (
                  // Chooses which figure the LINE plots. Inside a <label>, so
                  // every click must be prevented from toggling the checkbox.
                  <span className="ml-auto flex shrink-0 rounded-md border border-border overflow-hidden">
                    {([['count', '#'], ['value', '₹']] as const).map(([m, glyph]) => (
                      <button
                        key={m} type="button"
                        onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}
                        onClick={e => { e.preventDefault(); e.stopPropagation(); setJobsMetric(m) }}
                        aria-pressed={jobsMetric === m}
                        title={m === 'count' ? 'Plot the number of jobs' : 'Plot the ₹ value of those jobs'}
                        className={`px-1.5 py-0.5 text-[10px] leading-none transition-colors ${
                          jobsMetric === m
                            ? 'bg-foreground/10 text-foreground font-semibold'
                            : 'text-muted-foreground hover:text-foreground'}`}
                      >{glyph}</button>
                    ))}
                  </span>
                )}
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
                  <span className="text-[10px] text-muted-foreground" title={prevTruncated ? 'Previous period truncated to the same number of days elapsed (period-to-date)' : undefined}>
                    {prevTruncated ? 'prev to date' : 'prev'} {s.money ? fmt(prev) : prev.toLocaleString('en-IN')}
                  </span>
                )}
              </div>
              {isJobs && (
                <div className="mt-0.5 flex items-baseline gap-2 pl-[22px]">
                  <span className={`text-xs font-semibold tabular-nums ${jobsIsValue ? '' : 'text-muted-foreground'}`}>
                    {fmt(curVal)}
                  </span>
                  {pctVal != null && (
                    <span className={`text-[10px] font-medium ${pctVal >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                      {pctVal > 0 ? '+' : ''}{pctVal}%
                    </span>
                  )}
                  {prevVal != null && (
                    <span className="text-[10px] text-muted-foreground">
                      {prevTruncated ? 'prev to date' : 'prev'} {fmt(prevVal)}
                    </span>
                  )}
                </div>
              )}
            </label>
          )
        })}
      </div>

      {/* ── The graph ──
          Two stacked panes sharing one x-axis instead of a dual-axis chart:
          ₹ series (lines, top) and job counts (bars, bottom) are different
          scales — on one plot the jobs line reads as if comparable to money.
          syncId keeps the hover crosshair + tooltips in lockstep. */}
      {!anyVisible && (
        <div className="h-[240px] flex items-center justify-center text-xs text-muted-foreground">
          Select at least one series above.
        </div>
      )}
      {layout === 'combined' && anyVisible && (
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={combinedRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis
              dataKey="label"
              tick={AXIS_TICK} axisLine={false} tickLine={false}
              interval="preserveStartEnd" minTickGap={24}
            />
            <YAxis
              domain={[0, 100]} ticks={[0, 25, 50, 75, 100]}
              tick={AXIS_TICK} axisLine={false} tickLine={false}
              tickFormatter={v => `${v}%`} width={56}
            />
            <Tooltip
              {...TOOLTIP_STYLE}
              cursor={{ stroke: 'var(--border)' }}
              formatter={(value: any, name: any, item: any) => {
                const isPrev = String(name).startsWith('prev:')
                const key = (isPrev ? String(name).slice(5) : String(name)) as PlotKey
                const meta = PLOT_META[key]
                const raw = item?.payload?.[isPrev ? `raw_prev_${key}` : `raw_${key}`]
                const formatted = raw == null
                  ? `${value}%`
                  : meta?.money ? fmt(Number(raw)) : Number(raw).toLocaleString('en-IN')
                return [formatted, `${meta?.label ?? name}${isPrev ? ' (prev)' : ''}`]
              }}
              labelFormatter={(label: any, payload: any) => {
                const prevLabel = payload?.[0]?.payload?.prevLabel
                return compare && prevLabel ? `${label} · prev: ${prevLabel}` : label
              }}
            />
            {SERIES.filter(s => visible[s.key]).map(s => (
              <Line
                key={s.key} type="monotone"
                dataKey={plotKeyOf(s.key)} name={plotKeyOf(s.key)}
                stroke={s.color} strokeWidth={2} dot={false}
                activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }}
                connectNulls
              />
            ))}
            {compare && SERIES.filter(s => visible[s.key]).map(s => (
              <Line
                key={`prev_${s.key}`} type="monotone"
                dataKey={`prev_${plotKeyOf(s.key)}`} name={`prev:${plotKeyOf(s.key)}`}
                stroke={s.color} strokeWidth={1.5} strokeDasharray="5 4" strokeOpacity={0.5}
                dot={false} activeDot={{ r: 3, stroke: 'var(--card)', strokeWidth: 2 }}
                connectNulls
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      )}
      {layout === 'split' && anyMoney && (
        <ResponsiveContainer width="100%" height={showJobsPane ? 230 : 290}>
          <ComposedChart data={rows} syncId="business-trends" margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid {...GRID_PROPS} />
            {/* When the jobs strip is shown below, it carries the shared date
                labels — hiding them here avoids a duplicated axis row. */}
            <XAxis
              dataKey="label" hide={showJobsPane}
              tick={AXIS_TICK} axisLine={false} tickLine={false}
              interval="preserveStartEnd" minTickGap={24}
            />
            <YAxis
              tick={AXIS_TICK} axisLine={false} tickLine={false}
              tickFormatter={v => fmt(v)} width={56}
            />
            <Tooltip
              {...TOOLTIP_STYLE}
              cursor={{ stroke: 'var(--border)' }}
              formatter={(value: any, name: any) => {
                const isPrev = String(name).startsWith('prev:')
                const key = (isPrev ? String(name).slice(5) : String(name)) as PlotKey
                const meta = PLOT_META[key]
                return [fmt(Number(value)), `${meta?.label ?? name}${isPrev ? ' (prev)' : ''}`]
              }}
              labelFormatter={(label: any, payload: any) => {
                const prevLabel = payload?.[0]?.payload?.prevLabel
                return compare && prevLabel ? `${label} · prev: ${prevLabel}` : label
              }}
            />
            {SERIES.filter(s => isMoneyKey(s.key) && visible[s.key]).map(s => (
              <Line
                key={s.key} type="monotone"
                dataKey={plotKeyOf(s.key)} name={plotKeyOf(s.key)}
                stroke={s.color} strokeWidth={2} dot={false}
                activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }}
                connectNulls
              />
            ))}
            {compare && SERIES.filter(s => isMoneyKey(s.key) && visible[s.key]).map(s => (
              <Line
                key={`prev_${s.key}`} type="monotone"
                dataKey={`prev_${plotKeyOf(s.key)}`} name={`prev:${plotKeyOf(s.key)}`}
                stroke={s.color} strokeWidth={1.5} strokeDasharray="5 4" strokeOpacity={0.5}
                dot={false} activeDot={{ r: 3, stroke: 'var(--card)', strokeWidth: 2 }}
                connectNulls
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      )}
      {layout === 'split' && showJobsPane && (
        <ResponsiveContainer width="100%" height={anyMoney ? 110 : 240}>
          <ComposedChart data={rows} syncId="business-trends" margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid {...GRID_PROPS} />
            <XAxis
              dataKey="label"
              tick={AXIS_TICK} axisLine={false} tickLine={false}
              interval="preserveStartEnd" minTickGap={24}
            />
            <YAxis
              tick={AXIS_TICK} axisLine={false} tickLine={false}
              allowDecimals={false} width={56}
            />
            <Tooltip
              {...TOOLTIP_STYLE}
              cursor={{ stroke: 'var(--border)' }}
              formatter={(value: any, name: any) => {
                const isPrev = String(name).startsWith('prev:')
                return [Number(value).toLocaleString('en-IN'), `Jobs Received${isPrev ? ' (prev)' : ''}`]
              }}
              labelFormatter={(label: any, payload: any) => {
                const prevLabel = payload?.[0]?.payload?.prevLabel
                return compare && prevLabel ? `${label} · prev: ${prevLabel}` : label
              }}
            />
            <Line
              type="monotone" dataKey="jobs" name="jobs"
              stroke={JOBS_COLOR} strokeWidth={2} dot={false}
              activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }}
              connectNulls
            />
            {compare && (
              <Line
                type="monotone" dataKey="prev_jobs" name="prev:jobs"
                stroke={JOBS_COLOR} strokeWidth={1.5} strokeDasharray="5 4" strokeOpacity={0.5}
                dot={false} activeDot={{ r: 3, stroke: 'var(--card)', strokeWidth: 2 }}
                connectNulls
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      )}
      <p className="text-[10px] text-muted-foreground -mt-2">
        Solid = current period · dashed/faded = previous period, aligned by {periods.granularity === 'day' ? 'day' : 'month'} of period
        {prevTruncated && ' and truncated to the days elapsed so far (period-to-date)'}.
        Bank balance is the all-time running total.{' '}
        {layout === 'combined'
          ? 'Combined view scales each series to % of its own period peak so ₹ and job counts share one plot — hover for actual values.'
          : 'Jobs are counts, so they get their own pane instead of sharing the ₹ axis.'}
      </p>
    </section>
  )
}
