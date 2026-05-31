'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Admin dashboard — streamed analytics
//
// This is the heavy, below-the-fold half of the admin dashboard. It is rendered
// inside a <Suspense> boundary in `dashboard-client.tsx`, and the two biggest
// queries (`allAnalyticsTasks` = 36mo tasks + client/service joins, and
// `scores` = 36mo contribution scores + task join) arrive here as **unresolved
// promises** that we unwrap with React's `use()`. Until they resolve, the shell
// (header, period selector, Today's Focus, Expected-Cash hero) is already
// painted and interactive; this section streams in when the data is ready.
//
// Every calculation (`useMemo`) and every rendered element below is an
// unmodified move from the previous monolithic `DashboardClient` — only the
// data-fetch timing changed.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useMemo, use } from 'react'
import Link from 'next/link'
import { matchesDateFilter, getDateFilterLabel } from '@/components/ui/date-filter'
import type { DateFilterValue } from '@/components/ui/date-filter'
import {
  TrendingUp, TrendingDown, DollarSign, Clock, AlertTriangle,
  ClipboardList, ArrowRight, CheckCircle, ChevronRight,
  FileText, BarChart2, BarChart3, Calendar, Star, Users, Trophy, Briefcase,
} from 'lucide-react'
import { usePrivacy } from '@/contexts/privacy-context'
import {
  fmt, fmtFull, fmtDate, daysLate, daysToGo, getPeriodKey, getPeriodLabel,
  StatusBadge, IncomeOutflowBar, JobsDoneBar,
  WEEKDAY, MONTH_NAMES, FULL_MONTHS,
} from './dashboard-utils'
import type { Granularity, PulseTab, DrawerType } from './dashboard-utils'

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────
interface DashboardAnalyticsProps {
  // Heavy, deferred queries — passed as unresolved promises, unwrapped with use()
  allAnalyticsTasksPromise: Promise<any[]>
  scoresPromise: Promise<any[]>
  // Light data (already awaited on the server, needed for the analytics widgets)
  stats: {
    totalBilled: number; totalPaid: number; outstanding: number; bankBalance: number
    overdueCount: number; overdueAmount: number
    dueCount: number; dueAmount: number
    toBeInvoicedCount: number; toBeInvoicedAmount: number
    totalExpectedCash: number; totalDues: number
  }
  invoices: any[]; overdueInvoices: any[]; dueInvoices: any[]
  allCashbook: any[]; activeTasks: any[]; toBeInvoiced: any[]
  employees: any[]; payrollRecords: any[]
  // Shared state owned by the shell
  dateFilter: DateFilterValue
  granularity: Granularity
  setDrawer: React.Dispatch<React.SetStateAction<DrawerType>>
}

// ─────────────────────────────────────────────────────────────────────────────
// Main streamed component
// ─────────────────────────────────────────────────────────────────────────────
export default function DashboardAnalytics({
  allAnalyticsTasksPromise, scoresPromise,
  stats, invoices, overdueInvoices, dueInvoices, allCashbook,
  activeTasks, toBeInvoiced, employees, payrollRecords,
  dateFilter, granularity, setDrawer,
}: DashboardAnalyticsProps) {
  // ── Unwrap the streamed promises (suspends until resolved) ──────────────────
  const allAnalyticsTasks = use(allAnalyticsTasksPromise)
  const scores            = use(scoresPromise)

  const { dn } = usePrivacy()
  const [pulseTab, setPulseTab] = useState<PulseTab>('trends')

  const periodLabel = dateFilter ? getDateFilterLabel(dateFilter) : 'All time'

  // ── Cashbook filtered by dateFilter ───────────────────────────────────────
  const filteredCashbook = useMemo(() => {
    if (!dateFilter) return allCashbook
    return allCashbook.filter(e => matchesDateFilter(e.entry_date, dateFilter))
  }, [allCashbook, dateFilter])

  const periodInflow  = filteredCashbook.filter(e => e.type === 'inflow').reduce((s, e) => s + (e.amount_inr || 0), 0)
  const periodOutflow = filteredCashbook.filter(e => e.type === 'outflow').reduce((s, e) => s + (e.amount_inr || 0), 0)
  const netCash = periodInflow - periodOutflow

  // ── Trend chart data ───────────────────────────────────────────────────────
  const trendData = useMemo(() => {
    const map: Record<string, { inflow: number; outflow: number; taskValue: number; taskCount: number }> = {}
    const src = dateFilter ? filteredCashbook : allCashbook
    src.forEach(e => {
      const k = getPeriodKey(e.entry_date, granularity)
      if (!k) return
      if (!map[k]) map[k] = { inflow: 0, outflow: 0, taskValue: 0, taskCount: 0 }
      if (e.type === 'inflow')  map[k].inflow  += e.amount_inr || 0
      else                      map[k].outflow += e.amount_inr || 0
    })
    const taskSrc = dateFilter ? allAnalyticsTasks.filter(t => matchesDateFilter(t.task_date, dateFilter)) : allAnalyticsTasks
    taskSrc.forEach(t => {
      const k = getPeriodKey(t.task_date, granularity)
      if (!k) return
      if (!map[k]) map[k] = { inflow: 0, outflow: 0, taskValue: 0, taskCount: 0 }
      map[k].taskValue += t.billing_amount_inr || 0
      map[k].taskCount += 1
    })
    return Object.entries(map)
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([k, v]) => ({
        period: getPeriodLabel(k, granularity),
        inflow: Math.round(v.inflow), outflow: Math.round(v.outflow),
        net: Math.round(v.inflow - v.outflow),
        taskValue: Math.round(v.taskValue), taskCount: v.taskCount,
      }))
      .slice(-24) // last 24 periods
  }, [allCashbook, filteredCashbook, allAnalyticsTasks, dateFilter, granularity])

  // ── Current period vs previous comparison ─────────────────────────────────
  const periodComparison = useMemo(() => {
    const cur = trendData[trendData.length - 1]
    const prev = trendData[trendData.length - 2]
    if (!cur) return null
    const incomeChange = prev?.inflow ? Math.round(((cur.inflow - prev.inflow) / prev.inflow) * 100) : null
    const taskChange   = prev?.taskCount ? cur.taskCount - prev.taskCount : null
    const valueChange  = prev?.taskValue ? Math.round(((cur.taskValue - prev.taskValue) / prev.taskValue) * 100) : null
    return { cur, prev, incomeChange, taskChange, valueChange }
  }, [trendData])

  // ── Insights analytics ─────────────────────────────────────────────────────
  const analyticsTasks = useMemo(() => {
    if (!dateFilter) return allAnalyticsTasks
    return allAnalyticsTasks.filter(t => matchesDateFilter(t.task_date, dateFilter))
  }, [allAnalyticsTasks, dateFilter])

  // ── Cashbook insights (one-pass replacement for bestMonth + bestWeekday + avgDailyIncome) ──
  // Previously this section ran 3 separate full scans of `allCashbook` (which
  // can be thousands of rows). Collapsing to one pass keeps render time linear
  // in the input regardless of how many derived stats we surface.
  const cashbookInsights = useMemo(() => {
    const monthInflow:   Record<string, number> = {}
    const weekdayInflow: Record<number, number> = {}
    const inflowDays = new Set<string>()
    let totalInflow = 0

    for (const e of allCashbook) {
      if (e.type !== 'inflow') continue
      const amt = e.amount_inr || 0
      if (amt > 0) inflowDays.add(e.entry_date)
      totalInflow += amt
      const monthKey = e.entry_date?.slice(0, 7)
      if (monthKey) monthInflow[monthKey] = (monthInflow[monthKey] || 0) + amt
      if (e.entry_date) {
        const wd = new Date(e.entry_date + 'T12:00:00').getDay()
        weekdayInflow[wd] = (weekdayInflow[wd] || 0) + amt
      }
    }

    let bestMonth: { label: string; amount: number } | null = null
    let topMonth: [string, number] | null = null
    for (const entry of Object.entries(monthInflow)) {
      if (!topMonth || entry[1] > topMonth[1]) topMonth = entry as [string, number]
    }
    if (topMonth) {
      const [y, m] = topMonth[0].split('-')
      bestMonth = { label: `${MONTH_NAMES[parseInt(m) - 1]} ${y}`, amount: topMonth[1] }
    }

    let bestWeekday: { label: string; amount: number } | null = null
    let topWd: [string, number] | null = null
    for (const entry of Object.entries(weekdayInflow)) {
      if (!topWd || entry[1] > topWd[1]) topWd = entry as [string, number]
    }
    if (topWd) bestWeekday = { label: WEEKDAY[parseInt(topWd[0])], amount: topWd[1] }

    const avgDailyIncome = inflowDays.size > 0 ? totalInflow / inflowDays.size : 0

    return { bestMonth, bestWeekday, avgDailyIncome }
  }, [allCashbook])
  const { bestMonth, bestWeekday, avgDailyIncome } = cashbookInsights

  // ── Task insights (one-pass replacement for topClients + revenueByWorkType) ──
  // Previously two separate scans over `analyticsTasks`. Single pass collapses
  // both maps into one walk.
  const taskInsights = useMemo(() => {
    const byClient:  Record<string, { name: string; revenue: number; count: number }> = {}
    const byService: Record<string, { name: string; revenue: number; count: number }> = {}
    for (const t of analyticsTasks) {
      const rev = t.billing_amount_inr || 0
      const cid = t.client?.id; const cname = t.client?.name
      if (cid && cname) {
        if (!byClient[cid]) byClient[cid] = { name: cname, revenue: 0, count: 0 }
        byClient[cid].revenue += rev
        byClient[cid].count++
      }
      const sid = t.service_id; const sname = t.service?.name
      if (sid && sname) {
        if (!byService[sid]) byService[sid] = { name: sname, revenue: 0, count: 0 }
        byService[sid].revenue += rev
        byService[sid].count++
      }
    }
    const topClients       = Object.values(byClient).sort((a, b) => b.revenue - a.revenue).slice(0, 10)
    const revenueByWorkType = Object.values(byService).sort((a, b) => b.revenue - a.revenue).slice(0, 10)
    return { topClients, revenueByWorkType }
  }, [analyticsTasks])
  const { topClients, revenueByWorkType } = taskInsights

  // Revenue by season/month (calendar month, all-time)
  const revenueByMonth = useMemo(() => {
    const map: Record<number, number> = {}
    allAnalyticsTasks.forEach(t => {
      if (!t.task_date) return
      const m = new Date(t.task_date + 'T12:00:00').getMonth()
      map[m] = (map[m] || 0) + (t.billing_amount_inr || 0)
    })
    return Array.from({ length: 12 }, (_, i) => ({ month: FULL_MONTHS[i], revenue: map[i] || 0 }))
      .sort((a, b) => b.revenue - a.revenue)
  }, [allAnalyticsTasks])

  // Client outstanding (from invoices)
  const clientDues = useMemo(() => {
    const map: Record<string, { name: string; outstanding: number; invoiceCount: number }> = {}
    invoices.forEach(inv => {
      if (inv.status === 'paid') return
      const id = inv.client?.id; const name = inv.client?.name
      if (!id || !name) return
      if (!map[id]) map[id] = { name, outstanding: 0, invoiceCount: 0 }
      map[id].outstanding += (inv.total_amount || 0) - (inv.paid_amount || 0)
      map[id].invoiceCount++
    })
    return Object.values(map).filter(c => c.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding)
  }, [invoices])

  // ── Jobs vs Payroll monthly ────────────────────────────────────────────────
  const jobsVsPayroll = useMemo(() => {
    // Group tasks by month
    const taskMap: Record<string, { value: number; count: number }> = {}
    allAnalyticsTasks.forEach(t => {
      if (!t.task_date) return
      const k = t.task_date.slice(0, 7)
      if (!taskMap[k]) taskMap[k] = { value: 0, count: 0 }
      taskMap[k].value += t.billing_amount_inr || 0
      taskMap[k].count++
    })
    // Group payroll by month
    const payMap: Record<string, number> = {}
    payrollRecords.forEach(p => {
      const k = `${p.year}-${String(p.month).padStart(2,'0')}`
      payMap[k] = (payMap[k] || 0) + (p.net_salary || 0)
    })
    // Group inflow/outflow by month
    const cashMap: Record<string, { inflow: number; outflow: number }> = {}
    allCashbook.forEach(e => {
      const k = e.entry_date?.slice(0, 7)
      if (!k) return
      if (!cashMap[k]) cashMap[k] = { inflow: 0, outflow: 0 }
      if (e.type === 'inflow')  cashMap[k].inflow  += e.amount_inr || 0
      else                      cashMap[k].outflow += e.amount_inr || 0
    })
    // Merge all months
    const months = new Set([...Object.keys(taskMap), ...Object.keys(payMap), ...Object.keys(cashMap)])
    const rows = [...months].sort((a, b) => b.localeCompare(a)).slice(0, 24).map((k, i, arr) => {
      const [y, m] = k.split('-')
      const jobs = taskMap[k]?.value || 0
      const payroll = payMap[k] || 0
      const inflow = cashMap[k]?.inflow || 0
      const outflow = cashMap[k]?.outflow || 0
      const profit = jobs - payroll
      const pct = jobs > 0 ? Math.round((profit / jobs) * 100) : 0
      const netCashVal = inflow - outflow
      // cash change vs prev month
      const prevKey = arr[i + 1]
      const prevNet = prevKey ? (cashMap[prevKey]?.inflow || 0) - (cashMap[prevKey]?.outflow || 0) : 0
      const cashChange = prevNet !== 0 ? Math.round(((netCashVal - prevNet) / Math.abs(prevNet)) * 100) : null
      return {
        key: k,
        label: `${MONTH_NAMES[parseInt(m)-1]} ${y}`,
        payroll: Math.round(payroll),
        jobsDone: Math.round(jobs),
        jobCount: taskMap[k]?.count || 0,
        profit: Math.round(profit),
        pct,
        inflow: Math.round(inflow),
        outflow: Math.round(outflow),
        netCash: Math.round(netCashVal),
        cashChange,
      }
    })
    return rows
  }, [allAnalyticsTasks, payrollRecords, allCashbook])

  // ── Team earnings for period ───────────────────────────────────────────────
  // Dedup first: scores are ordered calculated_at DESC by the server, so the
  // first row seen per (employee_id, task.id) pair is the most recent
  // calculation. We never fall back to calculated_at as a date — if task_date
  // is absent the row is excluded to prevent recalculation history leakage.
  const teamEarnings = useMemo(() => {
    // Build per-employee maps: task.id → score row (newest calculation wins)
    const byEmp = new Map<string, Map<string, typeof scores[0]>>()
    for (const s of scores) {
      const tid = s.task?.id
      if (!tid) continue                                // !inner guarantees present; belt-and-suspenders
      const empMap = byEmp.get(s.employee_id) ?? new Map<string, typeof scores[0]>()
      if (!empMap.has(tid)) empMap.set(tid, s)         // first = newest
      byEmp.set(s.employee_id, empMap)
    }
    return employees.map(emp => {
      const all = [...(byEmp.get(emp.id)?.values() ?? [])]
      const filtered = dateFilter
        ? all.filter(s => {
            const d = s.task?.task_date ?? ''
            return d && matchesDateFilter(d, dateFilter) // task_date ONLY — never calculated_at
          })
        : all
      // Creatives credited = Σ (task.quantity × score_percentage / 100).
      // Mirrors how earnings are split — same source-of-truth score% from
      // commission.ts, inherits all group/parameter/tool weighting automatically.
      const creatives = filtered.reduce((acc, e) => {
        const qty   = Number(e.task?.quantity ?? 1)
        const share = (e.score_percentage ?? 0) / 100
        return acc + qty * share
      }, 0)
      return {
        ...emp,
        earnings:  filtered.reduce((acc, e) => acc + (e.earnings_inr  || 0), 0),
        taskCount: filtered.length,
        creatives,
      }
    })
  }, [employees, scores, dateFilter])

  // ── Admin production totals (per-period across the whole company) ──────────
  // Counts every task once (no dedup needed — analytics tasks query is canonical)
  // and sums their quantity. Independent of contribution scores: this is studio
  // output, not employee credit.
  const productionTotals = useMemo(() => {
    const src = dateFilter
      ? allAnalyticsTasks.filter(t => matchesDateFilter(t.task_date, dateFilter))
      : allAnalyticsTasks
    let creatives = 0
    for (const t of src) creatives += Number(t.quantity ?? 1)
    return { tasks: src.length, creatives }
  }, [allAnalyticsTasks, dateFilter])

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── KPI Cards ─────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiCard label="Total Billed"    value={fmt(stats.totalBilled)}       icon={<DollarSign className="w-3.5 h-3.5"/>} color="purple" trend={periodComparison ? { pct: periodComparison.valueChange } : null} />
        <KpiCard label="Collected"       value={fmt(stats.totalPaid)}          icon={<CheckCircle className="w-3.5 h-3.5"/>} color="green"  trend={periodComparison ? { pct: periodComparison.incomeChange } : null} />
        <KpiCard label="Bank Balance"    value={fmt(stats.bankBalance)}        icon={<TrendingUp className="w-3.5 h-3.5"/>}  color={stats.bankBalance >= 0 ? 'teal' : 'red'} sub="net cash" />
        <KpiCard label="Outstanding"     value={fmt(stats.outstanding)}        icon={<Clock className="w-3.5 h-3.5"/>}       color={stats.outstanding > 0 ? 'orange' : 'green'} trend={stats.outstanding > 0 ? { pct: null } : null} />
        <KpiCard label="Overdue"         value={fmt(stats.overdueAmount)}      icon={<AlertTriangle className="w-3.5 h-3.5"/>} color="red"    badge={stats.overdueCount} trend={stats.overdueCount > 0 ? { pct: null, invert: true } : null} clickable onClick={() => setDrawer('overdue')} />
        <KpiCard label="To Be Invoiced"  value={fmt(stats.toBeInvoicedAmount)} icon={<FileText className="w-3.5 h-3.5"/>}  color="yellow" badge={stats.toBeInvoicedCount} clickable onClick={() => setDrawer('toBeInvoiced')} />
      </div>

      {/* ── Production Output ─────────────────────────── */}
      {/* Distinct from financial KPIs — measures studio output (volume), not money. */}
      {/* Tasks = job count. Creatives = sum of task.quantity (pages/posts produced). */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard label="Tasks"      value={productionTotals.tasks.toLocaleString('en-IN')}                                              icon={<ClipboardList className="w-3.5 h-3.5"/>} color="purple" sub="in period" />
        <KpiCard label="Creatives"  value={productionTotals.creatives.toLocaleString('en-IN', { maximumFractionDigits: 0 })}            icon={<BarChart3 className="w-3.5 h-3.5"/>}      color="teal"   sub="pages/posts produced" />
        <KpiCard label="Avg/Task"   value={productionTotals.tasks > 0 ? (productionTotals.creatives/productionTotals.tasks).toFixed(1) : '—'} icon={<BarChart2 className="w-3.5 h-3.5"/>}     color="orange" sub="creatives per task" />
        <KpiCard label="Per Day"    value={productionTotals.tasks > 0 ? (productionTotals.creatives / Math.max(1, Math.ceil((dateFilter ? 30 : 365) * (productionTotals.tasks > 0 ? 1 : 0)))).toFixed(1) : '—'} icon={<TrendingUp className="w-3.5 h-3.5"/>} color="green" sub={dateFilter ? '~per day in window' : '~per day this year'} />
      </div>

      {/* ── Business Pulse tabs ───────────────────────── */}
      <section>
        <div className="flex items-center gap-1 mb-4 bg-secondary rounded-xl p-1 w-fit flex-wrap">
          {([
            { key: 'trends', label: 'Trends', icon: <BarChart2 className="w-3.5 h-3.5" /> },
            { key: 'invoices', label: 'Invoice Status', icon: <FileText className="w-3.5 h-3.5" /> },
            { key: 'performance', label: 'Performance', icon: <TrendingUp className="w-3.5 h-3.5" /> },
            { key: 'insights', label: 'Insights', icon: <Trophy className="w-3.5 h-3.5" /> },
          ] as { key: PulseTab; label: string; icon: React.ReactNode }[]).map(({ key, label, icon }) => (
            <button key={key} onClick={() => setPulseTab(key)}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition-all ${pulseTab === key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              {icon} {label}
            </button>
          ))}
        </div>

        {/* TRENDS TAB ─────────────────────────────────── */}
        {pulseTab === 'trends' && (
          <div className="space-y-4">
            {/* Comparison stats */}
            {periodComparison && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatChange label="Income" current={periodComparison.cur.inflow} prev={periodComparison.prev?.inflow} pct={periodComparison.incomeChange} format={fmt} />
                <StatChange label="Outflow" current={periodComparison.cur.outflow} prev={periodComparison.prev?.outflow} pct={null} format={fmt} invert />
                <StatChange label="Job Count" current={periodComparison.cur.taskCount} prev={periodComparison.prev?.taskCount} pct={periodComparison.taskChange} format={String} />
                <StatChange label="Job Value" current={periodComparison.cur.taskValue} prev={periodComparison.prev?.taskValue} pct={periodComparison.valueChange} format={fmt} />
              </div>
            )}

            {/* Income vs Outflow chart */}
            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-xs font-semibold text-muted-foreground mb-3 uppercase tracking-wider">Income vs Outflow ({granularity})</p>
              <IncomeOutflowBar data={trendData} fmt={fmt} />
            </div>

            {/* Job value + count chart */}
            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-xs font-semibold text-muted-foreground mb-3 uppercase tracking-wider">Jobs Done ({granularity})</p>
              <JobsDoneBar data={trendData} fmt={fmt} />
            </div>

            {/* Trend data table */}
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-border"><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Period Summary</p></div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-border bg-secondary/40">
                    <th className="text-left px-4 py-2 text-muted-foreground font-medium">Period</th>
                    <th className="text-right px-4 py-2 text-muted-foreground font-medium">Income</th>
                    <th className="text-right px-4 py-2 text-muted-foreground font-medium">Outflow</th>
                    <th className="text-right px-4 py-2 text-muted-foreground font-medium">Net</th>
                    <th className="text-right px-4 py-2 text-muted-foreground font-medium">Job Value</th>
                    <th className="text-right px-4 py-2 text-muted-foreground font-medium">Count</th>
                  </tr></thead>
                  <tbody className="divide-y divide-border/50">
                    {[...trendData].reverse().map((row, i) => (
                      <tr key={i} className="hover:bg-secondary/30">
                        <td className="px-4 py-2 font-medium">{row.period}</td>
                        <td className="px-4 py-2 text-right text-green-400">{fmt(row.inflow)}</td>
                        <td className="px-4 py-2 text-right text-red-400">{fmt(row.outflow)}</td>
                        <td className={`px-4 py-2 text-right font-semibold ${row.net >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmt(row.net)}</td>
                        <td className="px-4 py-2 text-right text-foreground">{fmt(row.taskValue)}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground">{row.taskCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* INVOICE STATUS TAB ──────────────────────────── */}
        {pulseTab === 'invoices' && (
          <div className="space-y-4">
            {/* Summary row */}
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 cursor-pointer hover:border-red-500/40 transition-colors" onClick={() => setDrawer('overdue')}>
                <p className="text-xs text-red-400 font-semibold">Overdue Invoices</p>
                <p className="text-xl font-bold text-foreground mt-0.5">{stats.overdueCount}</p>
                <p className="text-xs text-red-400 mt-0.5">{fmt(stats.overdueAmount)}</p>
              </div>
              <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl px-4 py-3 cursor-pointer hover:border-yellow-500/40 transition-colors" onClick={() => setDrawer('due')}>
                <p className="text-xs text-yellow-400 font-semibold">Due Invoices</p>
                <p className="text-xl font-bold text-foreground mt-0.5">{stats.dueCount}</p>
                <p className="text-xs text-yellow-400 mt-0.5">{fmt(stats.dueAmount)}</p>
              </div>
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl px-4 py-3 cursor-pointer hover:border-blue-500/40 transition-colors" onClick={() => setDrawer('toBeInvoiced')}>
                <p className="text-xs text-blue-400 font-semibold">To Be Invoiced</p>
                <p className="text-xl font-bold text-foreground mt-0.5">{stats.toBeInvoicedCount}</p>
                <p className="text-xs text-blue-400 mt-0.5">{fmt(stats.toBeInvoicedAmount)}</p>
              </div>
            </div>

            {/* Overdue table */}
            <InvoiceTable title="OVERDUE INVOICES" color="red" invoices={overdueInvoices} showDaysLate />
            {/* Due table */}
            <InvoiceTable title="DUE INVOICES" color="yellow" invoices={dueInvoices} showDaysToGo />
            {/* To be invoiced */}
            <TaskInvoiceTable title="TO BE INVOICED" tasks={toBeInvoiced} />

            {/* Client outstanding list */}
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Outstanding by Client</p>
                <p className="text-xs text-muted-foreground">{clientDues.length} clients</p>
              </div>
              <div className="divide-y divide-border/50">
                {clientDues.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">No outstanding amounts</p>
                ) : clientDues.map((c, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="text-xs text-muted-foreground w-5 shrink-0">{i+1}</span>
                    <p className="text-sm font-medium flex-1">{c.name}</p>
                    <span className="text-xs text-muted-foreground">{c.invoiceCount} inv</span>
                    <span className="text-sm font-semibold text-orange-400">{fmtFull(c.outstanding)}</span>
                  </div>
                ))}
                {clientDues.length > 0 && (
                  <div className="flex items-center gap-3 px-4 py-2.5 bg-secondary/30">
                    <span className="text-xs font-semibold flex-1">Total</span>
                    <span className="text-sm font-bold text-orange-400">{fmtFull(clientDues.reduce((s,c) => s+c.outstanding, 0))}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* PERFORMANCE TAB ─────────────────────────────── */}
        {pulseTab === 'performance' && (
          <div className="space-y-4">
            {/* Totals row */}
            {jobsVsPayroll.length > 0 && (() => {
              const totals = jobsVsPayroll.reduce((acc, r) => ({
                payroll: acc.payroll + r.payroll,
                jobsDone: acc.jobsDone + r.jobsDone,
                profit: acc.profit + r.profit,
                inflow: acc.inflow + r.inflow,
                outflow: acc.outflow + r.outflow,
                netCash: acc.netCash + r.netCash,
              }), { payroll: 0, jobsDone: 0, profit: 0, inflow: 0, outflow: 0, netCash: 0 })
              const pct = totals.jobsDone > 0 ? Math.round((totals.profit/totals.jobsDone)*100) : 0
              return (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-card border border-border rounded-xl px-4 py-3"><p className="text-[11px] text-muted-foreground">Total Payroll</p><p className="text-lg font-bold text-red-400 mt-0.5">{fmt(totals.payroll)}</p></div>
                  <div className="bg-card border border-border rounded-xl px-4 py-3"><p className="text-[11px] text-muted-foreground">Total Jobs Done</p><p className="text-lg font-bold text-green-400 mt-0.5">{fmt(totals.jobsDone)}</p></div>
                  <div className="bg-card border border-border rounded-xl px-4 py-3"><p className="text-[11px] text-muted-foreground">Total Profit</p><p className={`text-lg font-bold mt-0.5 ${totals.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmt(totals.profit)}</p></div>
                  <div className="bg-card border border-border rounded-xl px-4 py-3"><p className="text-[11px] text-muted-foreground">Avg Profit %</p><p className="text-lg font-bold mt-0.5">{pct}%</p></div>
                </div>
              )
            })()}

            {/* Jobs vs Payroll table */}
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-border"><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Jobs vs Payroll  ·  Inflow vs Outflow</p></div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[700px]">
                  <thead><tr className="border-b border-border bg-secondary/40">
                    <th className="text-left px-3 py-2.5 text-muted-foreground font-medium">Month</th>
                    <th className="text-right px-3 py-2.5 text-muted-foreground font-medium">Payroll</th>
                    <th className="text-right px-3 py-2.5 text-muted-foreground font-medium">Jobs Done</th>
                    <th className="text-right px-3 py-2.5 text-muted-foreground font-medium">Profit</th>
                    <th className="text-right px-3 py-2.5 text-muted-foreground font-medium">%</th>
                    <th className="text-right px-3 py-2.5 text-muted-foreground font-medium border-l border-border/50">Inflow</th>
                    <th className="text-right px-3 py-2.5 text-muted-foreground font-medium">Outflow</th>
                    <th className="text-right px-3 py-2.5 text-muted-foreground font-medium">Net Cash</th>
                    <th className="text-right px-3 py-2.5 text-muted-foreground font-medium">Change%</th>
                  </tr></thead>
                  <tbody className="divide-y divide-border/40">
                    {jobsVsPayroll.map((row, i) => (
                      <tr key={i} className="hover:bg-secondary/30 transition-colors">
                        <td className="px-3 py-2 font-medium">{row.label}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{row.payroll ? fmt(row.payroll) : '—'}</td>
                        <td className="px-3 py-2 text-right text-green-400">{row.jobsDone ? fmt(row.jobsDone) : '—'}</td>
                        <td className={`px-3 py-2 text-right font-semibold ${row.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{row.profit ? fmt(row.profit) : '—'}</td>
                        <td className={`px-3 py-2 text-right font-semibold ${row.pct >= 50 ? 'text-green-400' : row.pct >= 30 ? 'text-yellow-400' : 'text-red-400'}`}>{row.jobsDone ? `${row.pct}%` : '—'}</td>
                        <td className="px-3 py-2 text-right text-green-400 border-l border-border/30">{row.inflow ? fmt(row.inflow) : '—'}</td>
                        <td className="px-3 py-2 text-right text-red-400">{row.outflow ? fmt(row.outflow) : '—'}</td>
                        <td className={`px-3 py-2 text-right font-semibold ${row.netCash >= 0 ? 'text-green-400' : 'text-red-400'}`}>{fmt(row.netCash)}</td>
                        <td className={`px-3 py-2 text-right text-[11px] ${row.cashChange == null ? 'text-muted-foreground' : row.cashChange >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {row.cashChange == null ? '—' : `${row.cashChange >= 0 ? '+' : ''}${row.cashChange}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* INSIGHTS TAB ───────────────────────────────── */}
        {pulseTab === 'insights' && (
          <div className="space-y-4">
            {/* Records */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {bestMonth && (
                <div className="bg-card border border-border rounded-xl px-5 py-4">
                  <div className="flex items-center gap-2 mb-2"><Trophy className="w-4 h-4 text-yellow-400" /><p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Best Month</p></div>
                  <p className="text-base font-bold">{bestMonth.label}</p>
                  <p className="text-sm text-green-400 font-semibold mt-0.5">{fmtFull(bestMonth.amount)}</p>
                </div>
              )}
              {bestWeekday && (
                <div className="bg-card border border-border rounded-xl px-5 py-4">
                  <div className="flex items-center gap-2 mb-2"><Star className="w-4 h-4 text-blue-400" /><p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Best Weekday</p></div>
                  <p className="text-base font-bold">{bestWeekday.label}</p>
                  <p className="text-sm text-green-400 font-semibold mt-0.5">{fmtFull(bestWeekday.amount)}</p>
                </div>
              )}
              <div className="bg-card border border-border rounded-xl px-5 py-4">
                <div className="flex items-center gap-2 mb-2"><Calendar className="w-4 h-4 text-purple-400" /><p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Avg Daily Income</p></div>
                <p className="text-base font-bold">{fmtFull(avgDailyIncome)}</p>
                <p className="text-xs text-muted-foreground mt-0.5">per active day</p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Top clients */}
              <RankTable title="Top Clients" icon={<Users className="w-3.5 h-3.5 text-blue-400"/>} rows={topClients.map(c => ({ label: c.name, value: c.revenue, sub: `${c.count} jobs` }))} />
              {/* Revenue by work type */}
              <RankTable title="Revenue by Work Type" icon={<Briefcase className="w-3.5 h-3.5 text-purple-400"/>} rows={revenueByWorkType.map(s => ({ label: s.name, value: s.revenue, sub: `${s.count} jobs` }))} />
              {/* Revenue by season/month */}
              <RankTable title="Revenue by Season/Month" icon={<Calendar className="w-3.5 h-3.5 text-green-400"/>} rows={revenueByMonth.filter(r => r.revenue > 0).map(r => ({ label: r.month, value: r.revenue, sub: '' }))} />
            </div>
          </div>
        )}
      </section>

      {/* ── Bottom: Active Tasks + Cash + Team ─────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-card border border-border rounded-xl">
          <div className="px-4 py-3.5 border-b border-border flex items-center justify-between">
            <h2 className="font-semibold text-sm">Active Tasks</h2>
            <button onClick={() => setDrawer('active')} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">View all <ChevronRight className="w-3 h-3" /></button>
          </div>
          <div className="divide-y divide-border/60">
            {activeTasks.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">No active tasks</p>
            ) : activeTasks.slice(0, 7).map(t => (
              <div key={t.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-secondary/40">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{t.title}</p>
                  <p className="text-xs text-muted-foreground">{t.client?.name || '—'}{t.service ? ` · ${t.service.name}` : ''}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {t.billing_amount_inr > 0 && <span className="text-xs text-muted-foreground font-mono">{fmt(t.billing_amount_inr)}</span>}
                  <StatusBadge status={t.status} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          {/* Cash flow */}
          <div className="bg-card border border-border rounded-xl">
            <div className="px-4 py-3.5 border-b border-border flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-sm">Cash Flow</h2>
                <p className="text-[11px] text-muted-foreground mt-0.5">In: <span className="text-green-400">{fmt(periodInflow)}</span> · Out: <span className="text-red-400">{fmt(periodOutflow)}</span></p>
              </div>
              <Link href="/dashboard/cashbook" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">Cash Book <ArrowRight className="w-3 h-3" /></Link>
            </div>
            <div className="divide-y divide-border/60 max-h-48 overflow-y-auto">
              {filteredCashbook.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">No entries for this period</p>
              ) : filteredCashbook.slice(-10).reverse().map((e, i) => (
                <div key={i} className="px-4 py-2 flex items-center gap-3">
                  <div className="flex-1 min-w-0"><p className="text-xs truncate">{e.description || (e.type==='inflow' ? 'Income' : 'Expense')}</p><p className="text-[11px] text-muted-foreground/60">{fmtDate(e.entry_date)}</p></div>
                  <span className={`text-sm font-semibold shrink-0 ${e.type==='inflow' ? 'text-green-400' : 'text-red-400'}`}>{e.type==='inflow' ? '+' : '−'}{fmt(e.amount_inr||0)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Team earnings */}
          {employees.length > 0 && (
            <div className="bg-card border border-border rounded-xl">
              <div className="px-4 py-3.5 border-b border-border flex items-center justify-between">
                <div><h2 className="font-semibold text-sm">Team Earnings</h2><p className="text-[11px] text-muted-foreground mt-0.5">{periodLabel}</p></div>
                <Link href="/dashboard/reports" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">Reports <BarChart2 className="w-3 h-3" /></Link>
              </div>
              <div className="p-3 flex flex-wrap gap-2">
                {teamEarnings.map((emp, i) => {
                  const colors = ['from-violet-500 to-purple-600','from-blue-500 to-cyan-500','from-emerald-500 to-green-600','from-orange-500 to-amber-500','from-pink-500 to-rose-500','from-teal-500 to-cyan-600']
                  return (
                    <div key={emp.id} className="flex items-center gap-2 bg-secondary px-3 py-2 rounded-xl">
                      <div className={`w-7 h-7 rounded-full bg-gradient-to-br ${colors[i%colors.length]} flex items-center justify-center shrink-0`}>
                        <span className="text-white text-[10px] font-bold">{emp.cqid?.replace('CQID','') || '?'}</span>
                      </div>
                      <div>
                        <p className="text-xs font-semibold leading-tight">{dn(emp)}</p>
                        <p className={`text-[11px] font-semibold leading-tight ${emp.earnings > 0 ? 'text-green-400' : 'text-muted-foreground'}`}>
                          {emp.earnings > 0 ? fmt(emp.earnings) : emp.taskCount > 0 ? `${emp.taskCount} tasks` : 'No data'}
                        </p>
                        {emp.taskCount > 0 && (
                          <p className="text-[10px] text-muted-foreground/70 leading-tight mt-0.5">
                            {emp.taskCount} task{emp.taskCount === 1 ? '' : 's'} · {emp.creatives.toLocaleString('en-IN', { maximumFractionDigits: 1 })} creative{emp.creatives === 1 ? '' : 's'}
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components (analytics-only presentationals)
// ─────────────────────────────────────────────────────────────────────────────
function KpiCard({ label, value, icon, color, sub, badge, trend, onClick, clickable }: {
  label: string; value: string; icon: React.ReactNode; color: string
  sub?: string; badge?: number; trend?: { pct: number | null; invert?: boolean } | null
  onClick?: () => void; clickable?: boolean
}) {
  const cm: Record<string, string> = { purple:'bg-purple-500/15 text-purple-400', green:'bg-green-500/15 text-green-400', orange:'bg-orange-500/15 text-orange-400', red:'bg-red-500/15 text-red-400', yellow:'bg-yellow-500/15 text-yellow-400', teal:'bg-teal-500/15 text-teal-400' }
  const Tag = clickable ? 'button' : 'div'

  const showTrend = trend && trend.pct != null
  const positive  = showTrend ? (trend!.invert ? trend!.pct! < 0 : trend!.pct! > 0) : false
  const neutral   = showTrend && trend!.pct === 0

  return (
    <Tag onClick={onClick} className={`bg-card border border-border rounded-xl p-4 ${clickable ? 'hover:border-border/80 hover:bg-secondary/20 transition-all text-left w-full cursor-pointer' : ''}`}>
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] text-muted-foreground font-medium leading-tight">{label}</p>
        <div className={`w-6 h-6 rounded-md flex items-center justify-center ${cm[color] || cm.purple}`}>{icon}</div>
      </div>
      <div className="flex items-end gap-1.5">
        <p className="text-lg font-bold leading-tight">{value}</p>
        {badge != null && badge > 0 && <span className={`text-[10px] font-bold mb-0.5 px-1.5 py-0.5 rounded-full ${cm[color]}`}>{badge}</span>}
      </div>
      <div className="flex items-center gap-1.5 mt-0.5">
        {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
        {showTrend && !neutral && (
          <span className={`text-[10px] font-semibold flex items-center gap-0.5 ${positive ? 'text-green-400' : 'text-red-400'}`}>
            {positive ? <TrendingUp className="w-3 h-3"/> : <TrendingDown className="w-3 h-3"/>}
            {Math.abs(trend!.pct!)}% vs last mo.
          </span>
        )}
        {showTrend && neutral && (
          <span className="text-[10px] text-muted-foreground/50">= last mo.</span>
        )}
      </div>
    </Tag>
  )
}

function StatChange({ label, current, prev, pct, format, invert }: { label: string; current: number; prev?: number; pct: number | null; format: (n: number) => string; invert?: boolean }) {
  const positive = pct != null ? (invert ? pct < 0 : pct > 0) : null
  return (
    <div className="bg-card border border-border rounded-xl px-4 py-3">
      <p className="text-[11px] text-muted-foreground mb-1">{label}</p>
      <p className="text-lg font-bold">{format(current)}</p>
      {pct != null && (
        <p className={`text-[11px] font-semibold mt-0.5 flex items-center gap-0.5 ${positive ? 'text-green-400' : 'text-red-400'}`}>
          {positive ? <TrendingUp className="w-3 h-3"/> : <TrendingDown className="w-3 h-3"/>}
          {pct > 0 ? '+' : ''}{pct}{typeof pct === 'number' ? '%' : ''} vs prev
        </p>
      )}
      {prev != null && pct == null && <p className="text-[11px] text-muted-foreground mt-0.5">prev: {format(prev)}</p>}
    </div>
  )
}

function InvoiceTable({ title, color, invoices, showDaysLate, showDaysToGo }: { title: string; color: string; invoices: any[]; showDaysLate?: boolean; showDaysToGo?: boolean }) {
  const headerColors: Record<string, string> = { red: 'bg-red-500/15 text-red-400 border-red-500/20', yellow: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20' }
  // INR base for the company-wide due total (foreign invoices carry *_inr snapshots).
  const totalDue = invoices.reduce((s, i) => s + ((i.total_amount_inr ?? i.total_amount ?? 0) - (i.paid_amount_inr ?? i.paid_amount ?? 0)), 0)
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className={`px-4 py-3 border-b border-border flex items-center justify-between ${headerColors[color]}`}>
        <p className="text-xs font-bold uppercase tracking-wider">{title}</p>
        <div className="flex items-center gap-3 text-xs font-semibold">
          <span>{invoices.length} invoices</span>
          <span>Total: {fmtFull(totalDue)}</span>
        </div>
      </div>
      {invoices.length === 0 ? (
        <p className="px-4 py-5 text-center text-sm text-muted-foreground">None</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[500px]">
            <thead><tr className="border-b border-border bg-secondary/30">
              <th className="text-left px-4 py-2 text-muted-foreground font-medium">Invoice #</th>
              <th className="text-left px-4 py-2 text-muted-foreground font-medium">Client</th>
              <th className="text-right px-4 py-2 text-muted-foreground font-medium">Invoiced</th>
              <th className="text-right px-4 py-2 text-muted-foreground font-medium">Outstanding</th>
              <th className="text-right px-4 py-2 text-muted-foreground font-medium">Status</th>
            </tr></thead>
            <tbody className="divide-y divide-border/40">
              {invoices.map((inv, i) => {
                const owed = (inv.total_amount||0) - (inv.paid_amount||0)
                const days = inv.due_date ? (showDaysLate ? daysLate(inv.due_date) : -daysToGo(inv.due_date)) : null
                return (
                  <tr key={i} className="hover:bg-secondary/30">
                    <td className="px-4 py-2 font-mono font-medium">{inv.invoice_number || `#${inv.id?.slice(0,6)}`}</td>
                    <td className="px-4 py-2">{inv.client?.name || '—'}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{fmtFull(inv.total_amount||0)}</td>
                    <td className={`px-4 py-2 text-right font-semibold ${color==='red' ? 'text-red-400' : 'text-yellow-400'}`}>{fmtFull(owed)}</td>
                    <td className="px-4 py-2 text-right">
                      {days != null && (
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${showDaysLate ? 'bg-red-500/15 text-red-400' : 'bg-yellow-500/15 text-yellow-400'}`}>
                          {showDaysLate ? `${days}d late` : `${Math.abs(days)}d to go`}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function TaskInvoiceTable({ title, tasks }: { title: string; tasks: any[] }) {
  const total = tasks.reduce((s, t) => s + (t.billing_amount_inr||0), 0)
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-blue-500/10 border-blue-500/20 flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-wider text-blue-400">{title}</p>
        <div className="flex items-center gap-3 text-xs font-semibold text-blue-400">
          <span>{tasks.length} tasks</span>
          <span>Total: {fmtFull(total)}</span>
        </div>
      </div>
      {tasks.length === 0 ? (
        <p className="px-4 py-5 text-center text-sm text-muted-foreground">None</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[400px]">
            <thead><tr className="border-b border-border bg-secondary/30">
              <th className="text-left px-4 py-2 text-muted-foreground font-medium">Task</th>
              <th className="text-left px-4 py-2 text-muted-foreground font-medium">Client</th>
              <th className="text-left px-4 py-2 text-muted-foreground font-medium">Date</th>
              <th className="text-right px-4 py-2 text-muted-foreground font-medium">Amount</th>
            </tr></thead>
            <tbody className="divide-y divide-border/40">
              {tasks.map((t, i) => (
                <tr key={i} className="hover:bg-secondary/30">
                  <td className="px-4 py-2 font-medium max-w-[180px] truncate">{t.title || '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground">{t.client?.name || '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground">{t.task_date ? fmtDate(t.task_date) : '—'}</td>
                  <td className="px-4 py-2 text-right font-semibold text-blue-400">{fmtFull(t.billing_amount_inr||0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function RankTable({ title, icon, rows }: { title: string; icon: React.ReactNode; rows: { label: string; value: number; sub: string }[] }) {
  const maxVal = rows[0]?.value || 1
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3.5 border-b border-border flex items-center gap-2">
        {icon}
        <p className="text-xs font-semibold">{title}</p>
      </div>
      <div className="divide-y divide-border/50">
        {rows.length === 0 ? (
          <p className="px-4 py-5 text-center text-sm text-muted-foreground">No data</p>
        ) : rows.map((row, i) => (
          <div key={i} className="px-4 py-2.5">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] text-muted-foreground w-4 shrink-0">{i+1}</span>
              <span className="text-xs font-medium flex-1 truncate">{row.label}</span>
              <span className="text-xs font-semibold text-foreground shrink-0">{fmtFull(row.value)}</span>
            </div>
            <div className="ml-6 h-1 bg-border/50 rounded-full overflow-hidden">
              <div className="h-full gradient-bg rounded-full" style={{ width: `${Math.round((row.value/maxVal)*100)}%` }} />
            </div>
            {row.sub && <p className="text-[10px] text-muted-foreground ml-6 mt-0.5">{row.sub}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}
