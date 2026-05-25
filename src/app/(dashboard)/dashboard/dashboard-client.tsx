'use client'

import { useState, useMemo } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { DateFilter, matchesDateFilter, getDateFilterLabel } from '@/components/ui/date-filter'
import type { DateFilterValue } from '@/components/ui/date-filter'
import {
  TrendingUp, TrendingDown, DollarSign, Clock, AlertTriangle,
  ClipboardList, ArrowRight, CheckCircle, X, ChevronRight,
  FileText, BarChart2, BarChart3, Calendar, Star, Users, Trophy, Briefcase,
} from 'lucide-react'
import { usePrivacy } from '@/contexts/privacy-context'

// ─── Recharts is lazy-loaded — only fetched when a chart is rendered. ──────
// Saves ~95 KB on initial bundle & TTI for the (employee) dashboard, where
// charts may never even appear above the fold.
const ChartSkeleton = ({ h = 200 }: { h?: number }) => (
  <div className="w-full bg-secondary/30 rounded animate-pulse" style={{ height: h }} />
)
const IncomeOutflowBar = dynamic(
  () => import('./_charts').then(m => m.IncomeOutflowBar),
  { ssr: false, loading: () => <ChartSkeleton h={200} /> },
)
const JobsDoneBar = dynamic(
  () => import('./_charts').then(m => m.JobsDoneBar),
  { ssr: false, loading: () => <ChartSkeleton h={180} /> },
)
const ContributionActivityBar = dynamic(
  () => import('./_charts').then(m => m.ContributionActivityBar),
  { ssr: false, loading: () => <ChartSkeleton h={240} /> },
)

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface Props {
  stats: {
    totalBilled: number; totalPaid: number; outstanding: number; bankBalance: number
    overdueCount: number; overdueAmount: number
    dueCount: number; dueAmount: number
    toBeInvoicedCount: number; toBeInvoicedAmount: number
    totalExpectedCash: number; totalDues: number
  }
  invoices: any[]; overdueInvoices: any[]; dueInvoices: any[]
  allCashbook: any[]; displayTasks: any[]; allAnalyticsTasks: any[]
  todayTasks: any[]; unscoredDoneTasks: any[]; activeTasks: any[]; toBeInvoiced: any[]
  employees: any[]; scores: any[]; payrollRecords: any[]
  pendingContribCount?: number
  todayStr: string
  isAdmin?: boolean
}

type Granularity = 'daily' | 'monthly' | 'quarterly' | 'yearly'
type PulseTab = 'trends' | 'invoices' | 'performance' | 'insights'
type DrawerType = 'today' | 'missing' | 'overdue' | 'due' | 'toBeInvoiced' | 'active' | null

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function fmt(n: number) {
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`
  if (n >= 1000)   return `₹${(n / 1000).toFixed(1)}K`
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}
function fmtFull(n: number) {
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}
function fmtDate(d: string) {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
function daysLate(due: string): number {
  const d = new Date(due + 'T12:00:00')
  const now = new Date(); now.setHours(12, 0, 0, 0)
  return Math.floor((now.getTime() - d.getTime()) / 86400000)
}
function daysToGo(due: string): number {
  const d = new Date(due + 'T12:00:00')
  const now = new Date(); now.setHours(12, 0, 0, 0)
  return Math.ceil((d.getTime() - now.getTime()) / 86400000)
}

const WEEKDAY = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const FULL_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',
  in_progress: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  done: 'bg-green-500/15 text-green-400 border-green-500/20',
  invoiced: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
}
function StatusBadge({ status }: { status: string }) {
  return <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${STATUS_COLOR[status] || STATUS_COLOR.pending}`}>{status?.replace('_',' ')}</span>
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail Drawer
// ─────────────────────────────────────────────────────────────────────────────
function Drawer({ type, onClose, todayTasks, unscoredDoneTasks, overdueInvoices, dueInvoices, toBeInvoiced, activeTasks }: {
  type: DrawerType; onClose: () => void
  todayTasks: any[]; unscoredDoneTasks: any[]; overdueInvoices: any[]; dueInvoices: any[]
  toBeInvoiced: any[]; activeTasks: any[]
}) {
  if (!type) return null

  type Config = { title: string; subtitle?: string; items: any[]; render: (item: any) => React.ReactNode }
  const configs: Record<NonNullable<DrawerType>, Config> = {
    today: {
      title: "Today's Tasks", items: todayTasks,
      render: t => (
        <div className="flex items-center gap-3 px-5 py-3 hover:bg-secondary/40 transition-colors">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{t.title}</p>
            <p className="text-xs text-muted-foreground">{t.client?.name || '—'}{t.service ? ` · ${t.service.name}` : ''}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {t.billing_amount_inr > 0 && <span className="text-xs font-mono text-muted-foreground">{fmt(t.billing_amount_inr)}</span>}
            <StatusBadge status={t.status} />
          </div>
        </div>
      ),
    },
    missing: {
      title: 'Missing Contributions', items: unscoredDoneTasks,
      render: t => (
        <Link href="/dashboard/contributions" className="flex items-center gap-3 px-5 py-3 hover:bg-secondary/40 transition-colors group">
          <div className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{t.title}</p>
            <p className="text-xs text-muted-foreground">{t.client?.name || '—'}{t.task_date ? ` · ${fmtDate(t.task_date)}` : ''}{t.billing_amount_inr > 0 ? ` · ${fmt(t.billing_amount_inr)}` : ''}</p>
          </div>
          <ArrowRight className="w-3.5 h-3.5 text-muted-foreground/40 group-hover:text-foreground shrink-0" />
        </Link>
      ),
    },
    overdue: {
      title: 'Overdue Invoices', items: overdueInvoices,
      render: inv => (
        <Link href="/dashboard/invoices" className="flex items-center gap-3 px-5 py-3 hover:bg-secondary/40 transition-colors group">
          <div className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">{inv.invoice_number || `#${inv.id?.slice(0,6)}`}</p>
            <p className="text-xs text-muted-foreground">{inv.client?.name}{inv.due_date ? ` · Due ${fmtDate(inv.due_date)}` : ''}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-sm font-semibold text-red-400">{fmt((inv.total_amount||0)-(inv.paid_amount||0))}</p>
            {inv.due_date && <p className="text-[10px] text-red-400/60">{daysLate(inv.due_date)}d late</p>}
          </div>
        </Link>
      ),
    },
    due: {
      title: 'Due Invoices', items: dueInvoices,
      render: inv => (
        <Link href="/dashboard/invoices" className="flex items-center gap-3 px-5 py-3 hover:bg-secondary/40 transition-colors group">
          <div className="w-1.5 h-1.5 rounded-full bg-yellow-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">{inv.invoice_number || `#${inv.id?.slice(0,6)}`}</p>
            <p className="text-xs text-muted-foreground">{inv.client?.name}{inv.due_date ? ` · Due ${fmtDate(inv.due_date)}` : ''}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-sm font-semibold text-yellow-400">{fmt((inv.total_amount||0)-(inv.paid_amount||0))}</p>
            {inv.due_date && <p className="text-[10px] text-muted-foreground">{daysToGo(inv.due_date)}d to go</p>}
          </div>
        </Link>
      ),
    },
    toBeInvoiced: {
      title: 'To Be Invoiced', items: toBeInvoiced,
      render: t => (
        <Link href="/dashboard/invoices" className="flex items-center gap-3 px-5 py-3 hover:bg-secondary/40 transition-colors group">
          <div className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{t.title}</p>
            <p className="text-xs text-muted-foreground">{t.client?.name || '—'}{t.task_date ? ` · ${fmtDate(t.task_date)}` : ''}</p>
          </div>
          <span className="text-sm font-semibold shrink-0">{fmt(t.billing_amount_inr||0)}</span>
        </Link>
      ),
    },
    active: {
      title: 'Active Tasks', items: activeTasks,
      render: t => (
        <div className="flex items-center gap-3 px-5 py-3 hover:bg-secondary/40 transition-colors">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{t.title}</p>
            <p className="text-xs text-muted-foreground">{t.client?.name || '—'}{t.service ? ` · ${t.service.name}` : ''}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {t.billing_amount_inr > 0 && <span className="text-xs font-mono text-muted-foreground">{fmt(t.billing_amount_inr)}</span>}
            <StatusBadge status={t.status} />
          </div>
        </div>
      ),
    },
  }
  const { title, items, render } = configs[type]
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="w-full max-w-md bg-background border-l border-border flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="font-bold text-base">{title}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{items.length} item{items.length !== 1 ? 's' : ''}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-border/60">
          {items.length === 0 ? (
            <div className="px-5 py-12 text-center"><CheckCircle className="w-8 h-8 mx-auto mb-2 text-green-400/50" /><p className="text-sm text-muted-foreground">All clear!</p></div>
          ) : items.map((item, i) => <div key={i}>{render(item)}</div>)}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────
export default function DashboardClient({
  stats, invoices, overdueInvoices, dueInvoices, allCashbook,
  displayTasks, allAnalyticsTasks, todayTasks, unscoredDoneTasks,
  activeTasks, toBeInvoiced, employees, scores, payrollRecords,
  pendingContribCount = 0, todayStr, isAdmin = true
}: Props) {
  const { dn } = usePrivacy()
  const [dateFilter, setDateFilter] = useState<DateFilterValue>(null)
  const [granularity, setGranularity] = useState<Granularity>('monthly')
  const [pulseTab, setPulseTab] = useState<PulseTab>('trends')
  const [drawer, setDrawer] = useState<DrawerType>(null)

  if (!isAdmin) {
    return (
      <EmployeeDashboard
        todayStr={todayStr}
        scores={scores}
        payrollRecords={payrollRecords}
        pendingContribCount={pendingContribCount}
      />
    )
  }

  const today = new Date(todayStr + 'T12:00:00')
  const todayLabel = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const periodLabel = dateFilter ? getDateFilterLabel(dateFilter) : 'All time'

  // ── Period key helpers ─────────────────────────────────────────────────────
  function getPeriodKey(dateStr: string, g: Granularity): string {
    if (!dateStr) return ''
    const d = new Date(dateStr + 'T12:00:00')
    if (g === 'daily')     return dateStr
    if (g === 'monthly')   return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
    if (g === 'quarterly') { const q = Math.ceil((d.getMonth()+1)/3); return `${d.getFullYear()}-Q${q}` }
    return `${d.getFullYear()}`
  }
  function getPeriodLabel(key: string, g: Granularity): string {
    if (g === 'daily')   return key ? fmtDate(key) : key
    if (g === 'monthly') { const [y,m] = key.split('-'); return `${MONTH_NAMES[parseInt(m)-1]} ${y?.slice(2)}` }
    return key
  }

  // ── Cashbook filtered by dateFilter ───────────────────────────────────────
  const filteredCashbook = useMemo(() => {
    if (!dateFilter) return allCashbook
    return allCashbook.filter(e => matchesDateFilter(e.entry_date, dateFilter))
  }, [allCashbook, dateFilter])

  const periodInflow  = filteredCashbook.filter(e => e.type === 'inflow').reduce((s, e) => s + (e.amount_inr||0), 0)
  const periodOutflow = filteredCashbook.filter(e => e.type === 'outflow').reduce((s, e) => s + (e.amount_inr||0), 0)
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

  const urgentCount = unscoredDoneTasks.length + overdueInvoices.length

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div>
      <Header title="Dashboard" subtitle={todayLabel} />
      <div className="p-4 sm:p-6 space-y-5 sm:space-y-6">

        {/* ── Period Selector ──────────────────────────────── */}
        <div className="space-y-2">
          {/* Row 1: date filter */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground font-medium">Period:</span>
            <DateFilter value={dateFilter} onChange={setDateFilter} />
            {dateFilter && (
              <button onClick={() => setDateFilter(null)} className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-secondary transition-colors flex items-center gap-1">
                <X className="w-3 h-3" /> Clear
              </button>
            )}
          </div>
          {/* Row 2: granularity + period label */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center bg-secondary rounded-lg p-0.5 gap-0.5">
              {(['daily','monthly','quarterly','yearly'] as Granularity[]).map(g => (
                <button key={g} onClick={() => setGranularity(g)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium capitalize transition-all ${granularity === g ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                  {g}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground shrink-0">{periodLabel}</p>
          </div>
        </div>

        {/* ── Today's Focus ──────────────────────────────── */}
        {(urgentCount > 0 || todayTasks.length > 0) && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
              <h2 className="text-sm font-semibold">Today's Focus</h2>
              {urgentCount > 0 && <span className="text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/20 px-2 py-0.5 rounded-full">{urgentCount} need attention</span>}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {todayTasks.length > 0 && (
                <FocusCard icon={<CheckCircle className="w-4 h-4 text-blue-400" />} color="blue"
                  title="Today's Tasks" count={todayTasks.length} unit="task"
                  items={todayTasks.slice(0,3).map(t => t.title)}
                  onClick={() => setDrawer('today')} />
              )}
              {unscoredDoneTasks.length > 0 && (
                <FocusCard icon={<ClipboardList className="w-4 h-4 text-orange-400" />} color="orange"
                  title="Missing Contributions" count={unscoredDoneTasks.length} unit="task"
                  items={unscoredDoneTasks.slice(0,3).map(t => t.title)}
                  onClick={() => setDrawer('missing')} />
              )}
              {overdueInvoices.length > 0 && (
                <FocusCard icon={<AlertTriangle className="w-4 h-4 text-red-400" />} color="red"
                  title="Overdue Invoices" count={overdueInvoices.length} unit="invoice"
                  sub={fmt(stats.overdueAmount) + ' owed'}
                  items={overdueInvoices.slice(0,3).map(i => `${i.client?.name || i.invoice_number} — ${fmt((i.total_amount||0)-(i.paid_amount||0))}`)}
                  onClick={() => setDrawer('overdue')} />
              )}
            </div>
          </section>
        )}

        {/* ── Total Expected Cash hero ──────────────────── */}
        <div className="bg-card border border-primary/20 rounded-2xl p-5 relative overflow-hidden">
          <div className="absolute -right-8 -top-8 w-36 h-36 rounded-full bg-gradient-to-br from-violet-500/10 to-purple-600/5 pointer-events-none" />
          <div className="relative">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Total Expected Cash</p>
                <p className="text-3xl font-black gradient-text leading-tight">{fmt(stats.totalExpectedCash)}</p>
                <p className="text-xs text-muted-foreground mt-1.5">Bank balance + all outstanding + to be invoiced</p>
              </div>
              <div className="shrink-0 text-right space-y-0.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Breakdown</p>
                <p className="text-xs"><span className="text-muted-foreground">Bank balance</span> <span className="font-semibold">{fmt(stats.bankBalance)}</span></p>
                <p className="text-xs"><span className="text-muted-foreground">Outstanding invoices</span> <span className="font-semibold text-orange-400">{fmt(stats.outstanding)}</span></p>
                <p className="text-xs"><span className="text-muted-foreground">To be invoiced</span> <span className="font-semibold text-yellow-400">{fmt(stats.toBeInvoicedAmount)}</span></p>
              </div>
            </div>
            {stats.totalExpectedCash > 0 && (
              <div className="mt-4 h-1.5 bg-border rounded-full overflow-hidden flex gap-px">
                <div className="h-full bg-gradient-to-r from-violet-500 to-purple-500 rounded-full" style={{ width: `${Math.round((stats.bankBalance/stats.totalExpectedCash)*100)}%` }} />
                <div className="h-full bg-orange-400/70" style={{ width: `${Math.round((stats.outstanding/stats.totalExpectedCash)*100)}%` }} />
                <div className="h-full bg-yellow-400/70" style={{ width: `${Math.round((stats.toBeInvoicedAmount/stats.totalExpectedCash)*100)}%` }} />
              </div>
            )}
          </div>
        </div>

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
      </div>

      {/* Drawer */}
      <Drawer type={drawer} onClose={() => setDrawer(null)}
        todayTasks={todayTasks} unscoredDoneTasks={unscoredDoneTasks}
        overdueInvoices={overdueInvoices} dueInvoices={dueInvoices}
        toBeInvoiced={toBeInvoiced} activeTasks={activeTasks} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────
function FocusCard({ icon, color, title, count, unit, sub, items, onClick }: {
  icon: React.ReactNode; color: string; title: string; count: number; unit: string
  sub?: string; items: string[]; onClick: () => void
}) {
  const borders: Record<string, string> = { blue: 'border-blue-500/25 hover:border-blue-500/50', orange: 'border-orange-500/25 hover:border-orange-500/50', red: 'border-red-500/25 hover:border-red-500/50' }
  const bgs: Record<string, string> = { blue: 'bg-blue-500/15', orange: 'bg-orange-500/15', red: 'bg-red-500/15' }
  return (
    <button onClick={onClick} className={`group text-left bg-card border ${borders[color]} rounded-xl p-4 transition-all`}>
      <div className="flex items-start gap-3">
        <div className={`w-8 h-8 rounded-lg ${bgs[color]} flex items-center justify-center shrink-0 mt-0.5`}>{icon}</div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{count} {unit}{count !== 1 ? 's' : ''}{sub ? ` · ${sub}` : ''}</p>
          <div className="mt-2 space-y-0.5">
            {items.map((item, i) => <p key={i} className="text-xs text-muted-foreground/70 truncate">· {item}</p>)}
          </div>
        </div>
        <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0 mt-0.5" />
      </div>
    </button>
  )
}

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
  const totalDue = invoices.reduce((s, i) => s + ((i.total_amount||0)-(i.paid_amount||0)), 0)
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

// ─────────────────────────────────────────────────────────────────────────────
// Employee Dashboard (Restricted View)
// ─────────────────────────────────────────────────────────────────────────────

const SCORE_BANDS = [
  { label: '100%',   min: 100, max: 100, color: 'text-emerald-400', bg: 'bg-emerald-400' },
  { label: '76-99%', min: 76,  max: 99,  color: 'text-blue-400',    bg: 'bg-blue-400' },
  { label: '51-75%', min: 51,  max: 75,  color: 'text-purple-400',  bg: 'bg-purple-400' },
  { label: '26-50%', min: 26,  max: 50,  color: 'text-amber-400',   bg: 'bg-amber-400' },
  { label: '0-25%',  min: 0,   max: 25,  color: 'text-rose-400',    bg: 'bg-rose-400' },
] as const

const PAGE_SIZE = 25

function getPeriodKey(dateStr: string, g: Granularity): string {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T12:00:00')
  if (g === 'daily')     return dateStr
  if (g === 'monthly')   return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
  if (g === 'quarterly') { const q = Math.ceil((d.getMonth()+1)/3); return `${d.getFullYear()}-Q${q}` }
  return `${d.getFullYear()}`
}
function getPeriodLabel(key: string, g: Granularity): string {
  if (g === 'daily')   return key ? fmtDate(key) : key
  if (g === 'monthly') { const [y,m] = key.split('-'); return `${MONTH_NAMES[parseInt(m)-1]} ${y?.slice(2)}` }
  return key
}

function statusBadgeClass(status: string) {
  switch (status) {
    case 'done':      return 'bg-emerald-500/15 text-emerald-400'
    case 'delivered': return 'bg-blue-500/15 text-blue-400'
    case 'invoiced':  return 'bg-purple-500/15 text-purple-400'
    case 'paid':      return 'bg-green-500/15 text-green-400'
    case 'cancelled': return 'bg-rose-500/15 text-rose-400'
    default:          return 'bg-secondary text-muted-foreground'
  }
}

function EmployeeDashboard({
  todayStr, scores, payrollRecords: _payrollRecords, pendingContribCount = 0,
}: {
  todayStr: string; scores: any[]; payrollRecords: any[]; pendingContribCount?: number
}) {
  // ── Analytics filter state (controls KPI cards + breakdown + chart) ────────
  const [dateFilter, setDateFilter]   = useState<DateFilterValue>(null)
  const [granularity, setGranularity] = useState<Granularity>('monthly')

  // ── Recent contributions filter state (independent of analytics filter) ────
  const [histSearch,    setHistSearch]    = useState('')
  const [histStatus,    setHistStatus]    = useState('all')
  const [histBand,      setHistBand]      = useState('all')
  const [histPage,      setHistPage]      = useState(1)
  const [histExpanded,  setHistExpanded]  = useState(false)

  const today     = new Date(todayStr + 'T12:00:00')
  const todayLabel = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  // ── STEP 1: Deduplicate by task.id ─────────────────────────────────────────
  //
  // Server uses `!inner` join on tasks, so every row has task.id set.
  // Rows with NULL task_id (orphaned imports) are excluded automatically
  // by the inner join — they never reach the client.
  //
  // Server returns ordered by calculated_at DESC, so the first occurrence
  // of each task.id is the MOST RECENT calculation — the correct score.
  //
  // This is O(n) using a Set — safe for 50K+ rows.
  const dedupedScores = useMemo(() => {
    const seen = new Set<string>()
    return scores.filter(s => {
      const tid = s.task?.id  // guaranteed non-null with !inner join
      if (!tid || seen.has(tid)) return false
      seen.add(tid)
      return true
    })
  }, [scores])

  // ── STEP 2: Sort by real task_date descending ──────────────────────────────
  // All downstream consumers need newest-first order by actual work date.
  const sortedByDate = useMemo(() =>
    [...dedupedScores].sort((a, b) =>
      (b.task?.task_date ?? '').localeCompare(a.task?.task_date ?? '')
    ),
  [dedupedScores])

  // ── STEP 3: Filter by REAL task_date only — never fall back to calculated_at
  //
  // This is the critical fix for the 2023 phantom data:
  // - calculated_at is when the score was COMPUTED, not when the task was done
  // - A 2025 recalculation of a 2023 task has calculated_at in 2025 but
  //   task_date in 2023. With !inner join, task_date is always present.
  // - If task_date is somehow missing, the row is excluded rather than
  //   fallback to calculated_at (which would pull in wrong historical dates)
  const filteredScores = useMemo(() => {
    if (!dateFilter) return sortedByDate
    return sortedByDate.filter(s => {
      const d = s.task?.task_date ?? ''
      if (!d) return false           // exclude if no date — never use calculated_at
      return matchesDateFilter(d, dateFilter)
    })
  }, [sortedByDate, dateFilter])

  // ── KPI numbers (from filteredScores) ─────────────────────────────────────
  // My Contributions = unique tasks touched
  // My Creatives     = production output credited to me, computed as
  //                    Σ (task.quantity × score_percentage / 100). The score
  //                    already incorporates all group/parameter/tool weighting
  //                    from commission.ts, so this attribution is consistent
  //                    with how earnings are split.
  // Avg Creatives/Task = production density (>1 means catalogs/multi-page jobs)
  const myContributions = filteredScores.length
  const myCreatives = useMemo(() => {
    let total = 0
    for (const s of filteredScores) {
      const qty   = Number(s.task?.quantity ?? 1)
      const share = (s.score_percentage ?? 0) / 100
      total += qty * share
    }
    return total
  }, [filteredScores])
  const avgScore = filteredScores.length > 0
    ? Math.round(
        filteredScores.reduce((s, r) => s + (r.score_percentage ?? 0), 0) / filteredScores.length
      )
    : 0
  const avgCreativesPerTask = myContributions > 0 ? myCreatives / myContributions : 0

  // ── Band breakdown ─────────────────────────────────────────────────────────
  // Single-pass O(n) — one reduce instead of 5 separate .filter() calls
  const bandBreakdown = useMemo(() => {
    const counts = SCORE_BANDS.map(b => ({ ...b, tasks: 0 }))
    for (const s of filteredScores) {
      const pct = s.score_percentage ?? 0
      for (const b of counts) {
        if (pct >= b.min && pct <= b.max) { b.tasks++; break }
      }
    }
    return { bands: counts, total: filteredScores.length }
  }, [filteredScores])

  // ── Activity chart data ────────────────────────────────────────────────────
  // Bucketed by task_date (real work date), capped to last 24 periods.
  // Tracks both tasks (count of contributions) and creatives (qty × score%)
  // so the chart can overlay production density over time.
  const trendData = useMemo(() => {
    const map: Record<string, { count: number; creatives: number }> = {}
    for (const s of filteredScores) {
      const d = s.task?.task_date ?? ''
      const k = getPeriodKey(d, granularity)
      if (!k) continue
      if (!map[k]) map[k] = { count: 0, creatives: 0 }
      map[k].count += 1
      const qty   = Number(s.task?.quantity ?? 1)
      const share = (s.score_percentage ?? 0) / 100
      map[k].creatives += qty * share
    }
    return Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => ({
        period: getPeriodLabel(k, granularity),
        count: v.count,
        creatives: Math.round(v.creatives * 10) / 10,   // 1 decimal
      }))
      .slice(-24)
  }, [filteredScores, granularity])

  // ── Recent contributions list (independent filter state) ──────────────────
  // Uses sortedByDate (all deduped scores, not analytics-date-filtered) so
  // the user can browse full history while the analytics section is filtered.
  const histFiltered = useMemo(() => {
    const q = histSearch.trim().toLowerCase()
    return sortedByDate.filter(s => {
      const t = s.task
      if (!t) return false
      // Status
      if (histStatus !== 'all' && t.status !== histStatus) return false
      // Score band
      if (histBand !== 'all') {
        const band = SCORE_BANDS.find(b => b.label === histBand)
        if (band) {
          const pct = s.score_percentage ?? 0
          if (pct < band.min || pct > band.max) return false
        }
      }
      // Search: task_number or title (case-insensitive)
      if (q) {
        const num  = String(t.task_number ?? '').toLowerCase()
        const title = (t.title ?? '').toLowerCase()
        const client = (t.client?.name ?? '').toLowerCase()
        const svc   = (t.service?.name ?? '').toLowerCase()
        if (!num.includes(q) && !title.includes(q) && !client.includes(q) && !svc.includes(q)) return false
      }
      return true
    })
  }, [sortedByDate, histStatus, histBand, histSearch])

  // Reset page when filters change
  const resetPage = () => setHistPage(1)

  const histPageCount = Math.max(1, Math.ceil(histFiltered.length / PAGE_SIZE))
  const histPage1     = Math.min(histPage, histPageCount)
  const histVisible   = histFiltered.slice((histPage1 - 1) * PAGE_SIZE, histPage1 * PAGE_SIZE)

  // Unique clients + services for filter labels (computed once from all deduped scores)
  const { uniqueStatuses, uniqueClients, uniqueServices } = useMemo(() => {
    const statuses = new Set<string>()
    const clients  = new Set<string>()
    const services = new Set<string>()
    for (const s of sortedByDate) {
      if (s.task?.status)         statuses.add(s.task.status)
      if (s.task?.client?.name)   clients.add(s.task.client.name)
      if (s.task?.service?.name)  services.add(s.task.service.name)
    }
    return {
      uniqueStatuses: [...statuses].sort(),
      uniqueClients:  [...clients].sort(),
      uniqueServices: [...services].sort(),
    }
  }, [sortedByDate])

  return (
    <div>
      <Header title="My Workspace" subtitle={todayLabel} />
      <div className="p-4 md:p-6 space-y-6">

        {/* ── Pending-contributions nudge ──────────────────────────────────── */}
        {pendingContribCount > 0 && (
          <Link
            href="/dashboard/contributions"
            className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 hover:bg-amber-500/15 transition-colors group"
          >
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-amber-300">
                {pendingContribCount} task{pendingContribCount !== 1 ? 's' : ''} awaiting your contribution
              </p>
              <p className="text-[11px] text-amber-400/70 mt-0.5">Tap to open Contributions and log your work</p>
            </div>
            <ChevronRight className="w-4 h-4 text-amber-400/60 shrink-0 group-hover:translate-x-0.5 transition-transform" />
          </Link>
        )}

        {/* ── Analytics filters (control KPI + breakdown + chart) ───────────── */}
        <div className="flex items-center gap-2 flex-wrap bg-secondary/30 p-2 rounded-xl">
          <DateFilter value={dateFilter} onChange={v => { setDateFilter(v) }} />
          {dateFilter && (
            <button onClick={() => setDateFilter(null)} className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-secondary transition-colors">
              <X className="w-3 h-3 inline mr-1" />Clear
            </button>
          )}
          <div className="h-4 w-px bg-border mx-1" />
          <div className="flex items-center gap-0.5">
            {(['daily','monthly','quarterly','yearly'] as Granularity[]).map(g => (
              <button key={g} onClick={() => setGranularity(g)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium capitalize transition-all ${granularity === g ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                {g}
              </button>
            ))}
          </div>
        </div>

        {/* ── KPI cards ─────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-card border border-border rounded-xl p-4 flex flex-col justify-between hover:border-purple-500/30 transition-colors">
            <p className="text-[11px] text-muted-foreground font-medium">My Contributions</p>
            <p className="text-xl font-bold text-foreground mt-2">{myContributions}</p>
            <p className="text-[10px] text-muted-foreground/70 mt-0.5">
              {dateFilter ? 'tasks in selected period' : 'unique tasks contributed on'}
            </p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4 flex flex-col justify-between hover:border-emerald-500/30 transition-colors">
            <p className="text-[11px] text-muted-foreground font-medium">My Creatives</p>
            <p className="text-xl font-bold text-foreground mt-2">
              {myCreatives > 0 ? myCreatives.toLocaleString('en-IN', { maximumFractionDigits: 1 }) : '—'}
            </p>
            <p className="text-[10px] text-muted-foreground/70 mt-0.5">
              attributed by score % share
            </p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4 flex flex-col justify-between hover:border-orange-500/30 transition-colors">
            <p className="text-[11px] text-muted-foreground font-medium">Avg Score</p>
            <p className="text-xl font-bold text-foreground mt-2">{avgScore > 0 ? `${avgScore}%` : '—'}</p>
            <p className="text-[10px] text-muted-foreground/70 mt-0.5">
              {dateFilter ? 'mean score in period' : 'mean attribution percentage'}
            </p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4 flex flex-col justify-between hover:border-blue-500/30 transition-colors">
            <p className="text-[11px] text-muted-foreground font-medium">Avg Creatives / Task</p>
            <p className="text-xl font-bold text-foreground mt-2">
              {avgCreativesPerTask > 0 ? avgCreativesPerTask.toLocaleString('en-IN', { maximumFractionDigits: 1 }) : '—'}
            </p>
            <p className="text-[10px] text-muted-foreground/70 mt-0.5">
              production density per task
            </p>
          </div>
        </div>

        {/* ── Contribution Range Breakdown ──────────────────────────────────── */}
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-4">
            <BarChart3 className="w-4 h-4 text-purple-400" />
            <h2 className="text-sm font-semibold">Contribution Range Breakdown</h2>
            <span className="ml-auto text-[11px] text-muted-foreground">
              {bandBreakdown.total} task{bandBreakdown.total === 1 ? '' : 's'}
            </span>
          </div>
          {bandBreakdown.total === 0 ? (
            <div className="h-28 flex items-center justify-center border-t border-border/50">
              <p className="text-sm text-muted-foreground">No contributions in this period</p>
            </div>
          ) : (
            <div className="space-y-2">
              {bandBreakdown.bands.map(b => {
                const pct = bandBreakdown.total > 0 ? (b.tasks / bandBreakdown.total) * 100 : 0
                return (
                  <div key={b.label} className="flex items-center gap-3">
                    <span className={`text-xs font-semibold w-16 shrink-0 ${b.color}`}>{b.label}</span>
                    <div className="flex-1 h-2 rounded-full bg-secondary overflow-hidden">
                      <div className={`h-full rounded-full ${b.bg}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs font-medium text-foreground w-12 text-right tabular-nums">{b.tasks}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* ── Contribution Activity chart ────────────────────────────────────── */}
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-4">
            <ClipboardList className="w-4 h-4 text-purple-400" />
            <h2 className="text-sm font-semibold">Contribution Activity</h2>
          </div>
          {trendData.length === 0 ? (
            <div className="h-48 flex items-center justify-center border-t border-border/50">
              <p className="text-sm text-muted-foreground">No contributions in this period</p>
            </div>
          ) : (
            <ContributionActivityBar data={trendData} />
          )}
        </div>

        {/* ── My Recent Contributions ────────────────────────────────────────── */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {/* Section header + collapse toggle */}
          <button
            onClick={() => setHistExpanded(e => !e)}
            className="w-full flex items-center gap-2 px-4 py-3 border-b border-border hover:bg-secondary/30 transition-colors"
          >
            <FileText className="w-4 h-4 text-purple-400 shrink-0" />
            <h2 className="text-sm font-semibold flex-1 text-left">My Recent Contributions</h2>
            <span className="text-[11px] text-muted-foreground mr-2">
              {histFiltered.length} of {sortedByDate.length}
            </span>
            <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${histExpanded ? 'rotate-90' : ''}`} />
          </button>

          {histExpanded && (
            <>
              {/* Filter bar */}
              <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 border-b border-border bg-secondary/20">
                {/* Search */}
                <div className="relative flex-1 min-w-[140px]">
                  <input
                    type="text"
                    placeholder="Search #, title, client…"
                    value={histSearch}
                    onChange={e => { setHistSearch(e.target.value); resetPage() }}
                    className="w-full bg-background border border-border rounded-lg pl-3 pr-8 py-1.5 text-xs placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                  {histSearch && (
                    <button
                      onClick={() => { setHistSearch(''); resetPage() }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
                {/* Status */}
                <select
                  value={histStatus}
                  onChange={e => { setHistStatus(e.target.value); resetPage() }}
                  className="bg-background border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                >
                  <option value="all">All statuses</option>
                  {uniqueStatuses.map(s => (
                    <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                  ))}
                </select>
                {/* Score band */}
                <select
                  value={histBand}
                  onChange={e => { setHistBand(e.target.value); resetPage() }}
                  className="bg-background border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                >
                  <option value="all">All scores</option>
                  {SCORE_BANDS.map(b => (
                    <option key={b.label} value={b.label}>{b.label}</option>
                  ))}
                </select>
                {/* Clear */}
                {(histSearch || histStatus !== 'all' || histBand !== 'all') && (
                  <button
                    onClick={() => { setHistSearch(''); setHistStatus('all'); setHistBand('all'); resetPage() }}
                    className="text-[11px] text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-secondary transition-colors whitespace-nowrap"
                  >
                    <X className="w-3 h-3 inline mr-1" />Clear
                  </button>
                )}
              </div>

              {/* List */}
              {histVisible.length === 0 ? (
                <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
                  No contributions match the current filters
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {histVisible.map(s => {
                    const t = s.task
                    const pct = s.score_percentage ?? 0
                    const band = SCORE_BANDS.find(b => pct >= b.min && pct <= b.max)
                    return (
                      <Link
                        key={s.task_id}
                        href={`/dashboard/tasks`}
                        className="flex items-start gap-3 px-4 py-3 hover:bg-secondary/20 transition-colors group"
                      >
                        {/* Task number */}
                        <span className="text-[10px] font-mono text-muted-foreground/60 mt-0.5 shrink-0 min-w-[38px]">
                          {t.task_number ? `#${t.task_number}` : '—'}
                        </span>

                        {/* Main info */}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate leading-tight">
                            {t.title || '—'}
                          </p>
                          <p className="text-[11px] text-muted-foreground/70 mt-0.5 truncate">
                            {[
                              t.client?.name,
                              t.service?.name,
                              (Number(t.quantity ?? 1) > 1) ? `${t.quantity} creatives` : null,
                            ].filter(Boolean).join(' · ')}
                          </p>
                        </div>

                        {/* Right meta */}
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <span className={`text-[11px] font-semibold ${band?.color ?? 'text-muted-foreground'}`}>
                            {pct}%
                          </span>
                          {/* My share of this task's creatives */}
                          {Number(t.quantity ?? 1) > 1 && (
                            <span className="text-[10px] text-teal-400 font-medium tabular-nums">
                              {(Number(t.quantity) * pct / 100).toLocaleString('en-IN', { maximumFractionDigits: 1 })} cr.
                            </span>
                          )}
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${statusBadgeClass(t.status)}`}>
                            {t.status}
                          </span>
                          <span className="text-[10px] text-muted-foreground/50">
                            {t.task_date ? fmtDate(t.task_date) : '—'}
                          </span>
                        </div>
                      </Link>
                    )
                  })}
                </div>
              )}

              {/* Pagination */}
              {histPageCount > 1 && (
                <div className="flex items-center justify-between px-4 py-2.5 border-t border-border bg-secondary/10">
                  <span className="text-[11px] text-muted-foreground">
                    {(histPage1 - 1) * PAGE_SIZE + 1}–{Math.min(histPage1 * PAGE_SIZE, histFiltered.length)} of {histFiltered.length}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setHistPage(p => Math.max(1, p - 1))}
                      disabled={histPage1 === 1}
                      className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-secondary disabled:opacity-30 transition-colors"
                    >
                      <ChevronRight className="w-3.5 h-3.5 rotate-180" />
                    </button>
                    <span className="text-[11px] text-muted-foreground px-1">
                      {histPage1} / {histPageCount}
                    </span>
                    <button
                      onClick={() => setHistPage(p => Math.min(histPageCount, p + 1))}
                      disabled={histPage1 === histPageCount}
                      className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-secondary disabled:opacity-30 transition-colors"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

      </div>
    </div>
  )
}
