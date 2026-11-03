'use client'

// Dashboard — Departments panel. The figures are built in
// lib/finance/department-flows.ts (unit-tested); this file is presentation only.
// Explanations live in hover tips on the column titles rather than a footnote,
// so the panel reads as a plain table.

import { use, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { departmentFlows, UNASSIGNED_DEPT } from '@/lib/finance/department-flows'
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
          <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {choice === 'custom' && (
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
          <AppSelect aria-label="Period" value={choice} onChange={e => setChoice(e.target.value as PeriodChoice)}
            wrapperClassName="w-44" className="text-xs">
            <option value="page">{periodLabel}{periodLabel === 'All time' ? '' : ' (dashboard filter)'}</option>
            {PERIOD_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </AppSelect>
          <Link href="/dashboard/reports/department-pnl" className="text-xs text-primary hover:underline whitespace-nowrap">Department P&amp;L →</Link>
        </div>
      </div>
      {rows.length === 0 ? (
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
