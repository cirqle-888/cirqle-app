'use client'

// Dashboard — Departments panel. The figures are built in
// lib/finance/department-flows.ts (unit-tested); this file is presentation only.
// Explanations live in hover tips on the column titles rather than a footnote,
// so the panel reads as a plain table.

import { use, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { departmentFlows, UNASSIGNED_DEPT } from '@/lib/finance/department-flows'
import { departmentComparison, previousWindow, type CompareMetric, type MetricChange } from '@/lib/finance/department-compare'
import type { DepartmentFacts } from '@/lib/dashboard/department-facts'
import { resolveComparisonPeriods, resolveLastPeriods, addDays, type ComparisonMode } from '@/lib/finance/trends'
import { todayISO } from '@/lib/utils/local-date'
import AppSelect from '@/components/ui/app-select'

type DateWindow = { from: string; to: string }

/** 'page' follows the dashboard's own date filter; the rest are fixed periods. */
type PeriodChoice = 'page' | 'custom' | `${'this' | 'last'}:${Exclude<ComparisonMode, 'custom'>}`

const PERIOD_OPTIONS: { value: Exclude<PeriodChoice, 'page'>; label: string }[] = [
  { value: 'this:month', label: 'This month' },
  { value: 'last:month', label: 'Last month' },
  { value: 'this:quarter', label: 'This quarter' },
  { value: 'last:quarter', label: 'Last quarter' },
  { value: 'this:year', label: 'This year' },
  { value: 'last:year', label: 'Last year' },
  { value: 'this:week', label: 'This week' },
  { value: 'last:week', label: 'Last week' },
  { value: 'custom', label: 'Custom range…' },
]

type CompareMode = 'off' | Exclude<ComparisonMode, 'custom'>
const COMPARE_MODES: { value: CompareMode; label: string; current: string; previous: string }[] = [
  { value: 'off', label: 'Off', current: '', previous: '' },
  { value: 'week', label: 'Week', current: 'This week', previous: 'last week' },
  { value: 'month', label: 'Month', current: 'This month', previous: 'last month' },
  { value: 'quarter', label: 'Quarter', current: 'This quarter', previous: 'last quarter' },
  { value: 'year', label: 'Year', current: 'This year', previous: 'last year' },
]

// Colours from Business Trends, so the two read as one system.
const METRICS: { key: CompareMetric; label: string; color: string; money: boolean; lowerIsBetter?: boolean }[] = [
  { key: 'jobs', label: 'Jobs', color: '#8b5cf6', money: false },
  { key: 'jobValueInr', label: 'Job value', color: '#8b5cf6', money: true },
  { key: 'billedInr', label: 'Revenue', color: '#2563eb', money: true },
  { key: 'inflowInr', label: 'Inflow', color: '#059669', money: true },
  { key: 'outflowInr', label: 'Outflow', color: '#dc2626', money: true, lowerIsBetter: true },
  { key: 'netInr', label: 'Net', color: '#2563eb', money: true },
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "2026-10-01".."2026-10-31" → "1 Oct – 31 Oct 2026" (year once when shared). */
function rangeLabel(w: DateWindow): string {
  const [fy, fm, fd] = w.from.split('-').map(Number)
  const [ty, tm, td] = w.to.split('-').map(Number)
  const start = `${fd} ${MONTHS[fm - 1]}${fy !== ty ? ` ${fy}` : ''}`
  return `${start} – ${td} ${MONTHS[tm - 1]} ${ty}`
}

/**
 * A column title that explains itself on hover (or keyboard focus). The tip is
 * position:fixed so the table's horizontal scroll can't clip it.
 */
function Tip({ label, tip, align = 'right' }: { label: string; tip: string; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const open = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const width = 240
    const left = align === 'right' ? Math.max(8, r.right - width) : Math.min(r.left, window.innerWidth - width - 8)
    setPos({ top: r.bottom + 6, left })
  }
  return (
    <span ref={ref} tabIndex={0} onMouseEnter={open} onMouseLeave={() => setPos(null)} onFocus={open} onBlur={() => setPos(null)}
      className="cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 focus:outline-none focus-visible:text-foreground">
      {label}
      {pos && (
        <span role="tooltip" style={{ top: pos.top, left: pos.left, width: 240 }}
          className="fixed z-50 rounded-lg border border-border bg-popover px-3 py-2 text-left text-xs font-normal normal-case tracking-normal leading-relaxed text-muted-foreground shadow-xl pointer-events-none">
          {tip}
        </span>
      )}
    </span>
  )
}

export function DepartmentFlowsPanel({ factsPromise, window: pageWindow, outflowInr, outflowFor, periodLabel, fmt }: {
  factsPromise: Promise<DepartmentFacts | null>
  /** The dashboard date filter as a window; null = all time. */
  window: DateWindow | null
  /** The Outflow card's figure for the same window — shared out across departments. */
  outflowInr: number
  /** Operating outflow for any other window, for the panel's own period picker. */
  outflowFor: (w: DateWindow | null) => number
  periodLabel: string
  fmt: (v: number) => string
}) {
  const data = use(factsPromise)
  const today = todayISO()
  // 'page' keeps the panel on the dashboard's date filter (as before); the
  // other choices give it a period of its own, the same ones Business Trends has.
  const [choice, setChoice] = useState<PeriodChoice>('page')
  const [customFrom, setCustomFrom] = useState(addDays(today, -29))
  const [customTo, setCustomTo] = useState(today)
  // Compare: this period vs the previous one, period-to-date like Business Trends.
  const [compare, setCompare] = useState<CompareMode>('off')
  const [toDate, setToDate] = useState(true)
  const [barMetric, setBarMetric] = useState<CompareMetric>('billedInr')

  const own = useMemo<DateWindow | null>(() => {
    if (choice === 'page') return null
    if (choice === 'custom') {
      return customFrom && customTo && customFrom <= customTo ? { from: customFrom, to: customTo } : null
    }
    const [which, mode] = choice.split(':') as ['this' | 'last', Exclude<ComparisonMode, 'custom'>]
    return (which === 'last' ? resolveLastPeriods : resolveComparisonPeriods)(mode, today).current
  }, [choice, today, customFrom, customTo])
  const activeWindow = choice === 'page' ? pageWindow : own
  // Shared costs are spread by revenue share, so the outflow they spread must
  // be the one for the same window — the dashboard card's, or recomputed.
  const activeOutflow = useMemo(
    () => (choice === 'page' ? outflowInr : outflowFor(own)),
    [choice, outflowInr, outflowFor, own],
  )
  const subtitle = activeWindow ? rangeLabel(activeWindow) : periodLabel

  const rows = useMemo(
    () => (data ? departmentFlows(data.facts, activeWindow, activeOutflow) : []),
    [data, activeWindow, activeOutflow],
  )

  const comparison = useMemo(() => {
    if (!data || compare === 'off') return null
    const periods = resolveComparisonPeriods(compare, today)
    const prevWin = previousWindow(periods.current, periods.previous, toDate)
    return {
      current: periods.current,
      previous: prevWin,
      ...departmentComparison(
        data.facts,
        { window: periods.current, outflowInr: outflowFor(periods.current) },
        { window: prevWin, outflowInr: outflowFor(prevWin) },
      ),
    }
  }, [data, compare, today, toDate, outflowFor])
  if (!data) return null

  const name = new Map(data.departments.map(d => [d.id, d.name]))
  const label = (id: string) => (id === UNASSIGNED_DEPT ? 'Unassigned' : name.get(id) ?? 'Unknown')
  const total = rows.reduce((t, r) => ({
    jobs: t.jobs + r.jobs, jobValueInr: t.jobValueInr + r.jobValueInr, billedInr: t.billedInr + r.billedInr,
    inflowInr: t.inflowInr + r.inflowInr, outflowInr: t.outflowInr + r.outflowInr, netInr: t.netInr + r.netInr,
  }), { jobs: 0, jobValueInr: 0, billedInr: 0, inflowInr: 0, outflowInr: 0, netInr: 0 })
  const num = 'px-4 py-2.5 text-right tabular-nums whitespace-nowrap'
  const th = 'px-4 py-2.5 font-medium'
  // Shared-cost rounding can leave -0 or -0.001, which printed as "₹-0".
  const money = (v: number) => fmt(Math.abs(v) < 0.005 ? 0 : v)
  const payExceedsCash = total.outflowInr > activeOutflow + 0.5

  return (
    <section className="bg-card border border-border rounded-xl shadow-sm">
      <div className="px-4 py-3.5 border-b border-border flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-sm">Departments</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {comparison
              ? <>{rangeLabel(comparison.current)} <span className="text-muted-foreground/60">vs</span> {rangeLabel(comparison.previous)}{toDate ? ' · to date' : ''}</>
              : subtitle}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Compare with the previous period" className="flex items-center rounded-lg border border-border bg-secondary/40 p-0.5 text-xs">
            <span className="px-2 text-muted-foreground">Compare</span>
            {COMPARE_MODES.map(m => (
              <button key={m.value} type="button" aria-pressed={compare === m.value} onClick={() => setCompare(m.value)}
                className={`rounded-md px-2 py-1 font-medium transition-colors ${compare === m.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                {m.label}
              </button>
            ))}
          </div>
          {comparison && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none"
              title="To date compares the same number of days — 1–11 Nov with 1–11 Oct — like Business Trends. Off compares with the whole previous period.">
              <input type="checkbox" checked={toDate} onChange={e => setToDate(e.target.checked)} />
              To date
            </label>
          )}
          {!comparison && choice === 'custom' && (
            <div className="flex items-center gap-1.5 text-xs">
              <input type="date" value={customFrom} max={customTo} onChange={e => setCustomFrom(e.target.value)}
                aria-label="From"
                className="h-9 bg-background border border-input rounded-lg px-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/20" />
              <span className="text-muted-foreground">–</span>
              <input type="date" value={customTo} min={customFrom} max={today} onChange={e => setCustomTo(e.target.value)}
                aria-label="To"
                className="h-9 bg-background border border-input rounded-lg px-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/20" />
            </div>
          )}
          {!comparison && (
            <AppSelect aria-label="Period" value={choice} onChange={e => setChoice(e.target.value as PeriodChoice)}
              wrapperClassName="w-44" className="text-xs">
              <option value="page">{periodLabel}{periodLabel === 'All time' ? '' : ' (dashboard filter)'}</option>
              {PERIOD_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </AppSelect>
          )}
          <Link href="/dashboard/reports/department-pnl" className="text-xs text-primary hover:underline whitespace-nowrap">Department P&amp;L →</Link>
        </div>
      </div>
      {comparison ? (
        <DepartmentComparison
          rows={comparison.rows}
          total={comparison.total}
          label={label}
          money={money}
          metric={barMetric}
          onMetric={setBarMetric}
          currentLabel={COMPARE_MODES.find(m => m.value === compare)!.current}
          previousLabel={`${toDate ? '' : 'all of '}${COMPARE_MODES.find(m => m.value === compare)!.previous}`}
        />
      ) : rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">No department activity in this period</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b border-border bg-secondary/30">
                <th className={`${th} text-left`}>
                  <Tip label="Department" align="left"
                    tip="A department is a service category — the same grouping as the Department P&L." />
                </th>
                <th className={`${th} text-right`}>
                  <Tip label="Jobs" tip="Tasks dated in this period." />
                </th>
                <th className={`${th} text-right`}>
                  <Tip label="Job value" tip="What those tasks are worth at their task prices — the same figure as the dashboard's Job Value." />
                </th>
                <th className={`${th} text-right`}>
                  <Tip label="Revenue" tip="Billed on invoices in this period, split by the department of each invoice line." />
                </th>
                <th className={`${th} text-right`}>
                  <Tip label="Inflow" tip="Payments received in this period, split over the lines of the invoices they were allocated to. Cash with no invoice behind it goes to Unassigned." />
                </th>
                <th className={`${th} text-right`}>
                  <Tip label="Outflow" tip={payExceedsCash
                    ? `Designer pay already earned (${money(total.outflowInr)}). That is more than the ${money(activeOutflow)} actually paid out in this period, so no other costs are shared out yet.`
                    : 'Designer contribution pay (measured), plus every other operating cost shared out by each department\'s share of Revenue (an estimate). Hover a figure for its split.'} />
                </th>
                <th className={`${th} text-right`}>
                  <Tip label="Net" tip="Inflow minus Outflow." />
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map(r => (
                <tr key={r.deptId} className={r.deptId === UNASSIGNED_DEPT ? 'text-muted-foreground' : ''}>
                  <td className="px-4 py-2.5 font-medium">
                    {r.deptId === UNASSIGNED_DEPT
                      ? <Tip label="Unassigned" align="left" tip="Money with no department behind it — mostly payments not allocated to an invoice." />
                      : label(r.deptId)}
                  </td>
                  <td className={num}>{r.jobs}</td>
                  <td className={num}>{money(r.jobValueInr)}</td>
                  <td className={num}>{money(r.billedInr)}</td>
                  <td className={`${num} text-green-600 dark:text-green-500`}>{money(r.inflowInr)}</td>
                  <td className={`${num} text-red-600 dark:text-red-500`}
                    title={`Designer pay ${money(r.contributionPayInr)} + shared costs ${money(r.sharedCostInr)}`}>{money(r.outflowInr)}</td>
                  <td className={`${num} font-medium ${r.netInr < -0.005 ? 'text-red-600 dark:text-red-500' : ''}`}>{money(r.netInr)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-semibold bg-secondary/20">
                <td className="px-4 py-2.5">Total</td>
                <td className={num}>{total.jobs}</td>
                <td className={num}>{money(total.jobValueInr)}</td>
                <td className={num}>{money(total.billedInr)}</td>
                <td className={num}>{money(total.inflowInr)}</td>
                <td className={num}>{money(total.outflowInr)}</td>
                <td className={`${num} ${total.netInr < -0.005 ? 'text-red-600 dark:text-red-500' : ''}`}>{money(total.netInr)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  )
}

/** "+12.5%" / "−₹4.2K" in green or red; "new" when there was nothing before. */
function Change({ c, money, lowerIsBetter, fmt }: { c: MetricChange; money: boolean; lowerIsBetter?: boolean; fmt: (v: number) => string }) {
  if (Math.abs(c.delta) < 0.005) return <span className="text-muted-foreground/60">no change</span>
  const up = c.delta > 0
  const good = lowerIsBetter ? !up : up
  const cls = good ? 'text-emerald-600 dark:text-emerald-500' : 'text-red-600 dark:text-red-500'
  const sign = up ? '+' : '−'
  const text = c.pct != null
    ? `${sign}${Math.abs(c.pct)}%`
    : c.previous === 0 ? 'new' : `${sign}${money ? fmt(Math.abs(c.delta)) : Math.abs(c.delta)}`
  return <span className={`font-medium ${cls}`} title={`${sign}${money ? fmt(Math.abs(c.delta)) : Math.abs(c.delta)}`}>{text}</span>
}

/**
 * Departments, this period vs the previous: bars for one metric (solid = now,
 * faded = before, the same reading as the Business Trends lines), then every
 * column side by side. Numbers come from department-compare.ts.
 */
function DepartmentComparison({ rows, total, label, money, metric, onMetric, currentLabel, previousLabel }: {
  rows: ReturnType<typeof departmentComparison>['rows']
  total: ReturnType<typeof departmentComparison>['total']
  label: (id: string) => string
  money: (v: number) => string
  metric: CompareMetric
  onMetric: (m: CompareMetric) => void
  currentLabel: string
  previousLabel: string
}) {
  if (rows.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-muted-foreground">No department activity in either period</p>
  }
  const meta = METRICS.find(m => m.key === metric)!
  const show = (v: number, isMoney: boolean) => (isMoney ? money(v) : String(Math.round(v)))
  const max = Math.max(1, ...rows.flatMap(r => [Math.abs(r.metrics[metric].current), Math.abs(r.metrics[metric].previous)]))
  const width = (v: number) => `${Math.max(Math.abs(v) / max * 100, v !== 0 ? 1.5 : 0)}%`
  const num = 'px-4 py-2.5 text-right tabular-nums whitespace-nowrap align-top'
  const th = 'px-4 py-2.5 font-medium'

  return (
    <div>
      <div className="px-4 pt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Bars show">
          {METRICS.map(m => (
            <button key={m.key} type="button" aria-pressed={metric === m.key} onClick={() => onMetric(m.key)}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${metric === m.key ? 'border-primary/50 bg-primary/10 text-primary font-medium' : 'border-border text-muted-foreground hover:text-foreground'}`}>
              {m.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm" style={{ background: meta.color }} />{currentLabel}</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm opacity-35" style={{ background: meta.color }} />{previousLabel}</span>
        </div>
      </div>

      <div className="px-4 py-3 space-y-2.5">
        {rows.map(r => {
          const c = r.metrics[metric]
          return (
            <div key={r.deptId} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] sm:grid-cols-[minmax(0,11rem)_1fr_7.5rem] items-center gap-x-3">
              <span className={`truncate text-xs ${r.deptId === UNASSIGNED_DEPT ? 'text-muted-foreground' : 'font-medium'}`}>{label(r.deptId)}</span>
              <div className="space-y-1" title={`${currentLabel}: ${show(c.current, meta.money)} · ${previousLabel}: ${show(c.previous, meta.money)}`}>
                <div className="h-2.5 rounded-sm" style={{ width: width(c.current), background: c.current < 0 ? '#dc2626' : meta.color }} />
                <div className="h-2.5 rounded-sm opacity-35" style={{ width: width(c.previous), background: c.previous < 0 ? '#dc2626' : meta.color }} />
              </div>
              <div className="text-right text-xs tabular-nums leading-tight">
                <div className={c.current < -0.005 ? 'text-red-600 dark:text-red-500' : 'text-foreground'}>{show(c.current, meta.money)}</div>
                <div className="text-[11px]"><Change c={c} money={meta.money} lowerIsBetter={meta.lowerIsBetter} fmt={money} /></div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="overflow-x-auto border-t border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-secondary/30">
              <th className={`${th} text-left`}>Department</th>
              {METRICS.map(m => <th key={m.key} className={`${th} text-right`}>{m.label}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {[...rows, { deptId: '__total__', metrics: total }].map(r => {
              const isTotal = r.deptId === '__total__'
              return (
                <tr key={r.deptId} className={isTotal ? 'border-t border-border font-semibold bg-secondary/20' : r.deptId === UNASSIGNED_DEPT ? 'text-muted-foreground' : ''}>
                  <td className="px-4 py-2.5 font-medium align-top">{isTotal ? 'Total' : label(r.deptId)}</td>
                  {METRICS.map(m => {
                    const c = r.metrics[m.key]
                    return (
                      <td key={m.key} className={num}>
                        <div className={m.key === 'netInr' && c.current < -0.005 ? 'text-red-600 dark:text-red-500' : ''}>{show(c.current, m.money)}</div>
                        <div className="text-[11px] font-normal text-muted-foreground">
                          was {show(c.previous, m.money)} · <Change c={c} money={m.money} lowerIsBetter={m.lowerIsBetter} fmt={money} />
                        </div>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-2 text-[11px] text-muted-foreground border-t border-border/60">
        Each side is what this card shows for that period on its own. Outflow shares each period&apos;s own running costs by revenue, so it is an estimate; jobs, revenue and inflow are measured.
      </p>
    </div>
  )
}
