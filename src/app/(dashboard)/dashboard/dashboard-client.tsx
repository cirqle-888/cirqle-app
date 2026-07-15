'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard shell + router
//
// `DashboardClient` is a thin router: employees go to `EmployeeDashboard`,
// admins to `AdminDashboard`. The two heaviest data sets — 36-month analytics
// tasks and contribution scores — arrive as **unresolved promises** and are
// unwrapped with React `use()` *inside* a `<Suspense>` boundary. This lets the
// instant shell (header, period selector, Today's Focus, Expected-Cash hero)
// paint and become interactive while the analytics stream in.
//
// What moved OUT of this file (behaviour unchanged — only relocated):
//   • the heavy admin analytics + its sub-components → `dashboard-analytics.tsx`
//   • shared helpers / constants / lazy charts       → `dashboard-utils.tsx`
// Everything that remains here (Drawer, FocusCard, the shell layout, and the
// entire EmployeeDashboard) is byte-for-byte identical to the original, except
// the two array props became promise props read via `use()`.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useMemo, use, Suspense, useEffect, useCallback } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { DateFilter, matchesDateFilter, getDateFilterLabel } from '@/components/ui/date-filter'
import type { DateFilterValue } from '@/components/ui/date-filter'
import {
  AlertTriangle, ClipboardList, ArrowRight, CheckCircle, X, ChevronRight,
  FileText, BarChart3, TrendingUp, TrendingDown, Zap, PhoneCall, Send, BellRing,
} from 'lucide-react'
import {
  fmt, fmtFull, fmtDate, daysLate, daysToGo, getPeriodKey, getPeriodLabel,
  StatusBadge, ContributionActivityBar, useAmountDisplay,
} from './dashboard-utils'
import type { Granularity, DrawerType } from './dashboard-utils'
import DashboardAnalytics from './dashboard-analytics'
import { useWorkspace } from '@/contexts/workspace-context'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface Props {
  stats: {
    totalBilled: number; totalPaid: number; badDebtInr: number; outstanding: number; outstandingThisMonth: number; bankBalance: number
    overdueCount: number; overdueAmount: number
    dueCount: number; dueAmount: number
    toBeInvoicedCount: number; toBeInvoicedAmount: number
    totalExpectedCash: number; totalDues: number
  }
  invoices: any[]; overdueInvoices: any[]; dueInvoices: any[]
  allCashbook: any[]; displayTasks: any[]; allAnalyticsTasksPromise: Promise<any[]>
  todayTasks: any[]; unscoredDoneTasks: any[]; activeTasks: any[]; toBeInvoiced: any[]
  employees: any[]; scoresPromise: Promise<any[]>; payrollRecords: any[]
  pendingContribCount?: number
  /** Employee view: open tasks assigned to me + done tasks awaiting my contribution. */
  myActions?: { active: any[]; needContribution: any[] }
  todayStr: string
  isAdmin?: boolean
  /** Live rates from exchange_rates table — used only for the FX toggle, no accounting impact. */
  exchangeRates?: { currency: string; rate_to_inr: number }[]
  /** Collections follow-up counts — powers the dashboard Follow-ups widget. */
  followupCounts?: { needsSent: number; urgent: number; regular: number }
  /** Smart Focus extras — everything else it needs is derived from props already above. */
  notifications?: { rows: any[]; unreadCount: number }
  pendingRequests?: { count: number; items: { id: string; title: string }[] }
  draftInvoicesSample?: string[]
  payrollPendingCount?: number
  /** Company Ops strip (Finance Engine) — null pre-scope-migration or for non-admins. */
  companyOps?: import('@/lib/finance/kpis').CompanyOpsStrip | null
}

// ─────────────────────────────────────────────────────────────────────────────
// FX mode helpers
// ─────────────────────────────────────────────────────────────────────────────
const FX_MODE_KEY = 'cirqle-fx-mode'

function useFxMode() {
  const [mode, setModeState] = useState<'booked' | 'live'>('booked')
  // Hydrate from localStorage after mount (SSR-safe)
  useEffect(() => {
    try {
      const stored = localStorage.getItem(FX_MODE_KEY)
      if (stored === 'live') setModeState('live')
    } catch { /* localStorage unavailable */ }
  }, [])
  const setMode = useCallback((m: 'booked' | 'live') => {
    setModeState(m)
    try { localStorage.setItem(FX_MODE_KEY, m) } catch { /* ignore */ }
  }, [])
  return [mode, setMode] as const
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
        <div className="flex items-center gap-3 px-5 py-3 hover:bg-muted/50 transition-colors group">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">{t.title}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{t.client?.name || '—'}{t.service ? ` · ${t.service.name}` : ''}</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {t.billing_amount_inr > 0 && <span className="text-xs font-mono text-muted-foreground">{fmt(t.billing_amount_inr)}</span>}
            <StatusBadge status={t.status} />
          </div>
        </div>
      ),
    },
    missing: {
      title: 'Missing Contributions', items: unscoredDoneTasks,
      render: t => (
        <Link href="/dashboard/contributions" className="flex items-center gap-3 px-5 py-3 hover:bg-muted/50 transition-colors group">
          <div className="w-1.5 h-1.5 rounded-full bg-orange-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">{t.title}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{t.client?.name || '—'}{t.task_date ? ` · ${fmtDate(t.task_date)}` : ''}{t.billing_amount_inr > 0 ? ` · ${fmt(t.billing_amount_inr)}` : ''}</p>
          </div>
          <ArrowRight className="w-3.5 h-3.5 text-muted-foreground/50 group-hover:text-foreground shrink-0 transition-colors" />
        </Link>
      ),
    },
    overdue: {
      title: 'Overdue Invoices', items: overdueInvoices,
      render: inv => (
        <Link href="/dashboard/invoices" className="flex items-center gap-3 px-5 py-3 hover:bg-muted/50 transition-colors group">
          <div className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">{inv.invoice_number || `#${inv.id?.slice(0,6)}`}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{inv.client?.name}{inv.due_date ? ` · Due ${fmtDate(inv.due_date)}` : ''}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-sm font-semibold text-red-500">{fmt((inv.total_amount||0)-(inv.paid_amount||0))}</p>
            {inv.due_date && <p className="text-[10px] text-red-500/80 mt-0.5 font-medium">{daysLate(inv.due_date)}d late</p>}
          </div>
        </Link>
      ),
    },
    due: {
      title: 'Due Invoices', items: dueInvoices,
      render: inv => (
        <Link href="/dashboard/invoices" className="flex items-center gap-3 px-5 py-3 hover:bg-muted/50 transition-colors group">
          <div className="w-1.5 h-1.5 rounded-full bg-yellow-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">{inv.invoice_number || `#${inv.id?.slice(0,6)}`}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{inv.client?.name}{inv.due_date ? ` · Due ${fmtDate(inv.due_date)}` : ''}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-sm font-semibold text-yellow-500">{fmt((inv.total_amount||0)-(inv.paid_amount||0))}</p>
            {inv.due_date && <p className="text-[10px] text-muted-foreground mt-0.5 font-medium">{daysToGo(inv.due_date)}d to go</p>}
          </div>
        </Link>
      ),
    },
    toBeInvoiced: {
      title: 'To Be Invoiced', items: toBeInvoiced,
      render: t => (
        <Link href="/dashboard/invoices" className="flex items-center gap-3 px-5 py-3 hover:bg-muted/50 transition-colors group">
          <div className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">{t.title}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{t.client?.name || '—'}{t.task_date ? ` · ${fmtDate(t.task_date)}` : ''}</p>
          </div>
          <span className="text-sm font-semibold text-blue-500 shrink-0">{fmt(t.billing_amount_inr||0)}</span>
        </Link>
      ),
    },
    active: {
      title: 'Active Tasks', items: activeTasks,
      render: t => (
        <div className="flex items-center gap-3 px-5 py-3 hover:bg-muted/50 transition-colors group">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">{t.title}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{t.client?.name || '—'}{t.service ? ` · ${t.service.name}` : ''}</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
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
// Router — picks the employee vs admin view. No hooks here, so each view owns
// its own hook order cleanly (admin shell state vs employee filter state).
// ─────────────────────────────────────────────────────────────────────────────
export default function DashboardClient(props: Props) {
  if (!props.isAdmin) {
    // The employee view is entirely scores-driven, so it unwraps `scoresPromise`
    // with use() and must live under a <Suspense> boundary. The fallback keeps
    // the page header instant while the (employee-scoped) scores stream in.
    return (
      <Suspense fallback={<EmployeeDashboardSkeleton todayStr={props.todayStr} />}>
        <EmployeeDashboard
          todayStr={props.todayStr}
          scoresPromise={props.scoresPromise}
          payrollRecords={props.payrollRecords}
          pendingContribCount={props.pendingContribCount}
          myActions={props.myActions}
        />
      </Suspense>
    )
  }
  return <AdminDashboard {...props} />
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin dashboard — instant shell + streamed analytics
//
// Owns the shared period/granularity/drawer state (kept in the shell so the
// period controls stay interactive while analytics stream). The heavy analytics
// child reads `allAnalyticsTasksPromise` + `scoresPromise` via use(), so it is
// wrapped in its own <Suspense> with a dimension-matched skeleton fallback.
// ─────────────────────────────────────────────────────────────────────────────
function AdminDashboard({
  stats, invoices, overdueInvoices, dueInvoices, allCashbook,
  allAnalyticsTasksPromise, todayTasks, unscoredDoneTasks,
  activeTasks, toBeInvoiced, employees, scoresPromise, payrollRecords,
  todayStr, exchangeRates = [], followupCounts,
  notifications, pendingRequests, draftInvoicesSample = [], payrollPendingCount = 0,
  companyOps = null,
}: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [dateFilter, setDateFilter] = useState<DateFilterValue>(() => {
    const d = searchParams.get('date')
    try { return d ? JSON.parse(d) : null } catch { return null }
  })
  const [granularity, setGranularity] = useState<Granularity>((searchParams.get('granularity') as any) || 'monthly')
  const [drawer, setDrawer] = useState<DrawerType>(null)
  const [fxMode, setFxMode] = useFxMode()
  const [amountDisplay, setAmountDisplay] = useAmountDisplay()
  const f = amountDisplay === 'full' ? fmtFull : fmt

  // Per-workspace dashboard widget scoping — dashboardWidgetKeys=null (e.g.
  // "All Workspace") means unrestricted, matching today's behavior exactly.
  const { current: activeWorkspace } = useWorkspace()
  const shouldShow = (key: string) => !activeWorkspace.dashboardWidgetKeys || activeWorkspace.dashboardWidgetKeys.includes(key)

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString())
    if (dateFilter) params.set('date', JSON.stringify(dateFilter)); else params.delete('date')
    if (granularity && granularity !== 'monthly') params.set('granularity', granularity); else params.delete('granularity')

    const newQueryString = params.toString()
    if (newQueryString !== searchParams.toString()) {
      router.replace(`${pathname}?${newQueryString}`, { scroll: false })
    }
  }, [dateFilter, granularity, pathname, router, searchParams])

  const today = new Date(todayStr + 'T12:00:00')
  const todayLabel = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const periodLabel = dateFilter ? getDateFilterLabel(dateFilter) : 'All time'

  const urgentCount = unscoredDoneTasks.length + overdueInvoices.length
  const smartFocusCount = urgentCount + (pendingRequests?.count || 0) + draftInvoicesSample.length + payrollPendingCount + (notifications?.unreadCount || 0)

  // ── FX live calculations ─────────────────────────────────────────────────
  // Build a rate map from the live exchange_rates table (fetched server-side).
  const liveRateMap = useMemo(
    () => new Map(exchangeRates.map(r => [r.currency, r.rate_to_inr])),
    [exchangeRates]
  )
  // Revalue a single invoice at today's rate. INR invoices are unchanged.
  const liveInrOf = useCallback((inv: any): number => {
    if (!inv.currency || inv.currency === 'INR') return inv.total_amount_inr ?? inv.total_amount ?? 0
    const rate = liveRateMap.get(inv.currency) ?? inv.exchange_rate ?? 1
    return (inv.total_amount ?? 0) * rate
  }, [liveRateMap])
  const paidInrOf = (inv: any): number => inv.paid_amount_inr ?? inv.paid_amount ?? 0

  const liveFx = useMemo(() => {
    const sentInvs = invoices.filter((i: any) => ['sent', 'partial', 'overdue'].includes(i.status))
    const liveOutstanding  = sentInvs.reduce((s, i) => s + Math.max(0, liveInrOf(i) - paidInrOf(i)), 0)
    const liveOverdueAmt   = overdueInvoices.reduce((s, i) => s + Math.max(0, liveInrOf(i) - paidInrOf(i)), 0)
    return {
      outstanding:    liveOutstanding,
      overdueAmount:  liveOverdueAmt,
      totalExpectedCash: stats.bankBalance + liveOutstanding + stats.toBeInvoicedAmount,
      varianceOutstanding: liveOutstanding - stats.outstanding,
      varianceOverdue:     liveOverdueAmt  - stats.overdueAmount,
    }
  }, [invoices, overdueInvoices, liveInrOf, stats])

  // The stats used throughout the shell — identical to server values in Booked mode.
  const effectiveStats = fxMode === 'live'
    ? { ...stats, outstanding: liveFx.outstanding, overdueAmount: liveFx.overdueAmount, totalExpectedCash: liveFx.totalExpectedCash }
    : stats

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
          {/* Row 2: granularity + period label + FX toggle.
              flex-wrap: three button-groups (4 + 2 + 2 buttons) don't fit a
              375px viewport in one row — without wrap the FX Booked/Live
              toggle was clipped off-screen with no scroll container to reach
              it (genuinely inaccessible, not just cramped). Wrapping lets the
              FX group drop to its own line on phones; unchanged on wider
              screens where everything already fit on one line. */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center bg-secondary rounded-lg p-0.5 gap-0.5">
              {(['daily','monthly','quarterly','yearly'] as Granularity[]).map(g => (
                <button key={g} onClick={() => setGranularity(g)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium capitalize transition-all ${granularity === g ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                  {g}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <p className="text-xs text-muted-foreground hidden sm:block">{periodLabel}</p>
              {/* Amount display toggle */}
              <div className="flex items-center bg-secondary rounded-lg p-0.5 gap-0">
                <button
                  onClick={() => setAmountDisplay('short')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${amountDisplay === 'short' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  title="Abbreviated (₹1.5L)"
                >
                  1.5L
                </button>
                <button
                  onClick={() => setAmountDisplay('full')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${amountDisplay === 'full' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  title="Full figures (₹1,50,000)"
                >
                  Full
                </button>
              </div>
              {/* FX Mode toggle */}
              <div
                className="flex items-center bg-secondary rounded-lg p-0.5 gap-0"
                title="Booked = invoice exchange rate at invoice date&#10;Live = today's exchange rate from Settings"
              >
                <button
                  onClick={() => setFxMode('booked')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${fxMode === 'booked' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  Booked
                </button>
                <button
                  onClick={() => setFxMode('live')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all flex items-center gap-1 ${fxMode === 'live' ? 'bg-violet-500/20 text-violet-600 dark:text-violet-300 shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  <Zap className="w-2.5 h-2.5" />
                  Live
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ── Smart Focus — "what should I do now?" ──────── */}
        {/* Single prioritized action feed: today's work + everything across
            the app waiting on a decision (notifications, requests, drafts,
            payroll, contributions, overdue money). Replaces the old narrower
            "Today's Focus" (3 tiles) rather than stacking a second, competing
            "what needs attention" section next to it. */}
        {shouldShow('smart_focus') && (smartFocusCount > 0 || todayTasks.length > 0) && (
          <section>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
              <h2 className="text-sm font-semibold">Smart Focus</h2>
              {smartFocusCount > 0 && <span className="text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/20 px-2 py-0.5 rounded-full">{smartFocusCount} need attention</span>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {!!notifications?.unreadCount && (
                <FocusCard icon={<BellRing className="w-4 h-4 text-violet-400" />} color="violet"
                  title="Notifications" count={notifications.unreadCount} unit="unread"
                  items={notifications.rows.filter(r => !r.read).slice(0,3).map(r => r.title)}
                  onClick={() => router.push((notifications.rows.find(r => !r.read)?.link) || '/dashboard')} />
              )}
              {todayTasks.length > 0 && (
                <FocusCard icon={<CheckCircle className="w-4 h-4 text-blue-400" />} color="blue"
                  title="Today's Tasks" count={todayTasks.length} unit="task"
                  items={todayTasks.slice(0,3).map(t => t.title)}
                  onClick={() => setDrawer('today')} />
              )}
              {!!pendingRequests?.count && (
                <FocusCard icon={<ClipboardList className="w-4 h-4 text-cyan-400" />} color="cyan"
                  title="Requests Awaiting Action" count={pendingRequests.count} unit="request"
                  items={pendingRequests.items.map(r => r.title)}
                  onClick={() => router.push('/dashboard/requests')} />
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
                  sub={f(effectiveStats.overdueAmount) + ' owed'}
                  items={overdueInvoices.slice(0,3).map(i => `${i.client?.name || i.invoice_number} — ${f((i.total_amount||0)-(i.paid_amount||0))}`)}
                  onClick={() => setDrawer('overdue')} />
              )}
              {draftInvoicesSample.length > 0 && (
                <FocusCard icon={<Send className="w-4 h-4 text-amber-400" />} color="amber"
                  title="Drafts to Send" count={stats.toBeInvoicedCount} unit="invoice"
                  sub={f(stats.toBeInvoicedAmount)}
                  items={draftInvoicesSample}
                  onClick={() => router.push('/dashboard/invoices')} />
              )}
              {payrollPendingCount > 0 && (
                <FocusCard icon={<FileText className="w-4 h-4 text-emerald-400" />} color="emerald"
                  title="Payroll to Review" count={payrollPendingCount} unit="record"
                  items={[]}
                  onClick={() => router.push('/dashboard/payroll')} />
              )}
            </div>
          </section>
        )}

        {/* ── Collections follow-up widget ──────────────── */}
        {shouldShow('followups') && followupCounts && (followupCounts.urgent + followupCounts.regular + followupCounts.needsSent) > 0 && (
          <Link
            href="/dashboard/invoices/follow-ups"
            className="block bg-card border border-border rounded-2xl p-4 hover:border-primary/30 transition-colors group"
          >
            <div className="flex items-center gap-2 mb-3">
              <PhoneCall className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-semibold">Invoice Follow-ups</h2>
              <ArrowRight className="w-3.5 h-3.5 text-muted-foreground ml-auto group-hover:translate-x-0.5 transition-transform" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <FollowupTile icon={<AlertTriangle className="w-3.5 h-3.5" />} label="Urgent"      count={followupCounts.urgent}    tint="text-red-600 dark:text-red-400" />
              <FollowupTile icon={<BellRing className="w-3.5 h-3.5" />}      label="Regular"     count={followupCounts.regular}   tint="text-amber-600 dark:text-amber-400" />
              <FollowupTile icon={<Send className="w-3.5 h-3.5" />}          label="To be sent"  count={followupCounts.needsSent} tint="text-blue-600 dark:text-blue-400" />
            </div>
          </Link>
        )}

        {/* ── Total Expected Cash hero ──────────────────── */}
        {shouldShow('cash_overview') && (
        <div className="bg-card border border-primary/20 rounded-2xl p-5 relative overflow-hidden">
          <div className="absolute -right-8 -top-8 w-36 h-36 rounded-full bg-gradient-to-br from-violet-500/10 to-purple-600/5 pointer-events-none" />
          <div className="relative">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Total Expected Cash</p>
                  {fxMode === 'live' && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-violet-500/15 text-violet-600 dark:text-violet-300 border border-violet-500/20 px-1.5 py-0.5 rounded-full">
                      <Zap className="w-2.5 h-2.5" /> Live FX
                    </span>
                  )}
                </div>
                <p className="text-3xl font-black gradient-text leading-tight">{f(effectiveStats.totalExpectedCash)}</p>
                <p className="text-xs text-muted-foreground mt-1.5">Bank balance + all outstanding + to be invoiced</p>
              </div>
              <div className="shrink-0 text-right space-y-0.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Breakdown</p>
                <p className="text-xs"><span className="text-muted-foreground">Bank balance</span> <span className="font-semibold">{f(stats.bankBalance)}</span></p>
                <p className="text-xs">
                  <span className="text-muted-foreground">Outstanding invoices</span>{' '}
                  <span className="font-semibold text-orange-400">{f(effectiveStats.outstanding)}</span>
                </p>
                <p className="text-xs"><span className="text-muted-foreground">To be invoiced</span> <span className="font-semibold text-yellow-400">{f(stats.toBeInvoicedAmount)}</span></p>
              </div>
            </div>
            {effectiveStats.totalExpectedCash > 0 && (
              <div className="mt-4 h-1.5 bg-border rounded-full overflow-hidden flex gap-px">
                <div className="h-full bg-gradient-to-r from-violet-500 to-purple-500 rounded-full" style={{ width: `${Math.round((stats.bankBalance/effectiveStats.totalExpectedCash)*100)}%` }} />
                <div className="h-full bg-orange-400/70" style={{ width: `${Math.round((effectiveStats.outstanding/effectiveStats.totalExpectedCash)*100)}%` }} />
                <div className="h-full bg-yellow-400/70" style={{ width: `${Math.round((stats.toBeInvoicedAmount/effectiveStats.totalExpectedCash)*100)}%` }} />
              </div>
            )}
          </div>
        </div>
        )}

        {/* ── FX Variance card (Live mode only) ────────── */}
        {shouldShow('cash_overview') && fxMode === 'live' && (
          <div className="bg-card border border-violet-500/20 rounded-2xl p-4 grid grid-cols-3 gap-3">
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1"
                title="Outstanding using exchange rate locked at invoice date">
                Booked Outstanding
              </p>
              <p className="text-lg font-bold">{f(stats.outstanding)}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Locked rate</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1"
                title="Outstanding using today's exchange rate from Settings">
                Live Outstanding
              </p>
              <p className="text-lg font-bold text-violet-600 dark:text-violet-300">{f(liveFx.outstanding)}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Today's rate</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">FX Variance</p>
              {liveFx.varianceOutstanding === 0 ? (
                <p className="text-lg font-bold text-muted-foreground">—</p>
              ) : liveFx.varianceOutstanding > 0 ? (
                <>
                  <p className="text-lg font-bold text-emerald-500 flex items-center gap-1">
                    <TrendingUp className="w-4 h-4" />{f(liveFx.varianceOutstanding)}
                  </p>
                  <p className="text-[10px] text-emerald-500/70 mt-0.5">Unrealized gain</p>
                </>
              ) : (
                <>
                  <p className="text-lg font-bold text-red-400 flex items-center gap-1">
                    <TrendingDown className="w-4 h-4" />{f(Math.abs(liveFx.varianceOutstanding))}
                  </p>
                  <p className="text-[10px] text-red-400/70 mt-0.5">Unrealized loss</p>
                </>
              )}
            </div>
          </div>
        )}

        {/* ── Streamed analytics (KPIs · Production · Pulse · bottom grid) ──── */}
        {/* These read the two heavy promises via use(); the shell above already
            painted. The fallback mirrors the real section's dimensions. */}
        {shouldShow('analytics') && (
        <Suspense fallback={<AnalyticsSkeleton />}>
          <DashboardAnalytics
            allAnalyticsTasksPromise={allAnalyticsTasksPromise}
            scoresPromise={scoresPromise}
            companyOps={companyOps}
            stats={effectiveStats}
            invoices={invoices}
            overdueInvoices={overdueInvoices}
            dueInvoices={dueInvoices}
            allCashbook={allCashbook}
            activeTasks={activeTasks}
            toBeInvoiced={toBeInvoiced}
            employees={employees}
            payrollRecords={payrollRecords}
            dateFilter={dateFilter}
            granularity={granularity}
            setDrawer={setDrawer}
            displayFull={amountDisplay === 'full'}
          />
        </Suspense>
        )}
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
function FollowupTile({ icon, label, count, tint }: { icon: React.ReactNode; label: string; count: number; tint: string }) {
  return (
    <div className="rounded-lg bg-secondary/50 border border-border px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1">
        <span className={tint}>{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className={`text-xl font-bold ${count > 0 ? tint : 'text-muted-foreground/50'}`}>{count}</div>
    </div>
  )
}

function FocusCard({ icon, color, title, count, unit, sub, items, onClick }: {
  icon: React.ReactNode; color: string; title: string; count: number; unit: string
  sub?: string; items: string[]; onClick: () => void
}) {
  const borders: Record<string, string> = {
    blue: 'border-blue-500/25 hover:border-blue-500/60', orange: 'border-orange-500/25 hover:border-orange-500/60', red: 'border-red-500/25 hover:border-red-500/60',
    violet: 'border-violet-500/25 hover:border-violet-500/60', cyan: 'border-cyan-500/25 hover:border-cyan-500/60', amber: 'border-amber-500/25 hover:border-amber-500/60', emerald: 'border-emerald-500/25 hover:border-emerald-500/60',
  }
  const bgs: Record<string, string> = {
    blue: 'bg-blue-500/15', orange: 'bg-orange-500/15', red: 'bg-red-500/15',
    violet: 'bg-violet-500/15', cyan: 'bg-cyan-500/15', amber: 'bg-amber-500/15', emerald: 'bg-emerald-500/15',
  }
  return (
    <button onClick={onClick} className={`group text-left bg-card border ${borders[color]} shadow-sm rounded-xl p-4.5 transition-all hover:shadow-md hover:bg-muted/30`}>
      <div className="flex items-start gap-3.5">
        <div className={`w-8 h-8 rounded-lg ${bgs[color]} flex items-center justify-center shrink-0 mt-0.5`}>{icon}</div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-foreground group-hover:text-primary transition-colors">{title}</p>
          <p className="text-[11px] font-medium text-muted-foreground mt-0.5">{count} {unit}{count !== 1 ? 's' : ''}{sub ? ` · ${sub}` : ''}</p>
          <div className="mt-2.5 space-y-1">
            {items.map((item, i) => <p key={i} className="text-[11px] font-medium text-muted-foreground/80 truncate">· {item}</p>)}
          </div>
        </div>
        <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0 mt-0.5 group-hover:translate-x-0.5" />
      </div>
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Suspense fallbacks — dimension-matched skeletons (minimise CLS when the
// streamed content swaps in). Each is a Fragment so the parent `space-y-*`
// rhythm is preserved exactly when the real content takes its place.
// ─────────────────────────────────────────────────────────────────────────────
function AnalyticsSkeleton() {
  return (
    <>
      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-24 bg-card border border-border rounded-xl animate-pulse" />
        ))}
      </div>
      {/* Production output */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 bg-card border border-border rounded-xl animate-pulse" />
        ))}
      </div>
      {/* Business Pulse */}
      <div>
        <div className="h-10 w-80 max-w-full bg-secondary/40 rounded-xl animate-pulse mb-4" />
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-16 bg-card border border-border rounded-xl animate-pulse" />
            ))}
          </div>
          <div className="h-52 bg-card border border-border rounded-xl animate-pulse" />
          <div className="h-44 bg-card border border-border rounded-xl animate-pulse" />
        </div>
      </div>
      {/* Bottom grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="h-64 bg-card border border-border rounded-xl animate-pulse" />
        <div className="h-64 bg-card border border-border rounded-xl animate-pulse" />
      </div>
    </>
  )
}

function EmployeeDashboardSkeleton({ todayStr }: { todayStr: string }) {
  const today = new Date(todayStr + 'T12:00:00')
  const todayLabel = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  return (
    <div>
      <Header title="My Workspace" subtitle={todayLabel} />
      <div className="p-4 md:p-6 space-y-6">
        {/* Analytics filters */}
        <div className="h-12 w-full max-w-md bg-secondary/30 rounded-xl animate-pulse" />
        {/* KPI cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 bg-card border border-border rounded-xl animate-pulse" />
          ))}
        </div>
        {/* Breakdown */}
        <div className="h-44 bg-card border border-border rounded-xl animate-pulse" />
        {/* Activity chart */}
        <div className="h-64 bg-card border border-border rounded-xl animate-pulse" />
        {/* Recent contributions */}
        <div className="h-14 bg-card border border-border rounded-xl animate-pulse" />
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
  todayStr, scoresPromise, payrollRecords: _payrollRecords, pendingContribCount = 0,
  myActions = { active: [], needContribution: [] },
}: {
  todayStr: string; scoresPromise: Promise<any[]>; payrollRecords: any[]; pendingContribCount?: number
  myActions?: { active: any[]; needContribution: any[] }
}) {
  // Unwrap the streamed (employee-scoped) scores. Suspends until resolved; the
  // <Suspense> boundary in the router shows EmployeeDashboardSkeleton meanwhile.
  const scores = use(scoresPromise)

  // ── Analytics filter state (controls KPI cards + breakdown + chart) ────────
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [dateFilter, setDateFilter] = useState<DateFilterValue>(() => {
    const d = searchParams.get('date')
    try { return d ? JSON.parse(d) : null } catch { return null }
  })
  const [granularity, setGranularity] = useState<Granularity>((searchParams.get('granularity') as any) || 'monthly')

  // ── Recent contributions filter state (independent of analytics filter) ────
  const [histSearch,    setHistSearch]    = useState(searchParams.get('h_search') || '')
  const [histStatus,    setHistStatus]    = useState(searchParams.get('h_status') || 'all')
  const [histBand,      setHistBand]      = useState(searchParams.get('h_band') || 'all')
  const [histPage,      setHistPage]      = useState(parseInt(searchParams.get('h_page') || '1', 10))
  const [histExpanded,  setHistExpanded]  = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString())
    if (dateFilter) params.set('date', JSON.stringify(dateFilter)); else params.delete('date')
    if (granularity && granularity !== 'monthly') params.set('granularity', granularity); else params.delete('granularity')
    if (histSearch) params.set('h_search', histSearch); else params.delete('h_search')
    if (histStatus && histStatus !== 'all') params.set('h_status', histStatus); else params.delete('h_status')
    if (histBand && histBand !== 'all') params.set('h_band', histBand); else params.delete('h_band')
    if (histPage > 1) params.set('h_page', histPage.toString()); else params.delete('h_page')

    const newQueryString = params.toString()
    if (newQueryString !== searchParams.toString()) {
      router.replace(`${pathname}?${newQueryString}`, { scroll: false })
    }
  }, [dateFilter, granularity, histSearch, histStatus, histBand, histPage, pathname, router, searchParams])

  const today     = new Date(todayStr + 'T12:00:00')
  const todayLabel = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  // ── STEP 1: Deduplicate by task.id AND employee_id ───────────────────────
  //
  // Server uses `!inner` join on tasks, so every row has task.id set.
  // Rows with NULL task_id (orphaned imports) are excluded automatically.
  //
  // Server returns ordered by calculated_at DESC, so the first occurrence
  // of each task.id + employee_id is the MOST RECENT calculation.
  //
  // We MUST include employee_id in the deduplication key, because a single
  // task calculation inserts multiple rows (one for each contributing employee)
  // at the exact same calculated_at timestamp. Deduplicating by task.id alone
  // would throw away all but one employee's contribution for shared tasks!
  const dedupedScores = useMemo(() => {
    const seen = new Set<string>()
    return scores.filter(s => {
      const tid = s.task?.id
      const eid = s.employee_id
      if (!tid || !eid) return false
      const key = `${tid}-${eid}`
      if (seen.has(key)) return false
      seen.add(key)
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

        {/* ── Needs your action — first thing on load ─────────────────────── */}
        {(myActions.needContribution.length > 0 || myActions.active.length > 0) && (
          <div className="bg-card border border-border rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border/60 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              <p className="text-sm font-semibold">Needs your action</p>
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/25">
                {myActions.needContribution.length + myActions.active.length}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border/60">
              {/* Add your contribution */}
              <div className="p-3.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-400/90 mb-2">
                  Add your contribution · {myActions.needContribution.length}
                </p>
                {myActions.needContribution.length === 0 && (
                  <p className="text-xs text-muted-foreground/60">All caught up 🎉</p>
                )}
                <div className="space-y-1.5">
                  {myActions.needContribution.slice(0, 6).map((t: any) => (
                    <Link key={t.id} href={`/dashboard/contributions?search=${encodeURIComponent('#' + (t.task_number ?? ''))}`}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 -mx-2 hover:bg-secondary/60 transition-colors group">
                      <span className="text-[10px] font-mono text-muted-foreground shrink-0">#{t.task_number ?? '—'}</span>
                      <span className="text-xs font-medium truncate flex-1">{t.title}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0 truncate max-w-[90px]">{t.client?.name || ''}</span>
                      <ChevronRight className="w-3 h-3 text-muted-foreground/40 shrink-0 group-hover:translate-x-0.5 transition-transform" />
                    </Link>
                  ))}
                  {myActions.needContribution.length > 6 && (
                    <Link href="/dashboard/contributions" className="block text-[11px] text-violet-400 hover:text-violet-300 px-2 pt-1">
                      +{myActions.needContribution.length - 6} more in Contributions →
                    </Link>
                  )}
                </div>
              </div>
              {/* Open tasks on my plate */}
              <div className="p-3.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-400/90 mb-2">
                  Your open tasks · {myActions.active.length}
                </p>
                {myActions.active.length === 0 && (
                  <p className="text-xs text-muted-foreground/60">Nothing pending — nice.</p>
                )}
                <div className="space-y-1.5">
                  {myActions.active.slice(0, 6).map((t: any) => (
                    <Link key={t.id} href={`/dashboard/tasks?q=${encodeURIComponent('#' + (t.task_number ?? ''))}`}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 -mx-2 hover:bg-secondary/60 transition-colors group">
                      <span className="text-[10px] font-mono text-muted-foreground shrink-0">#{t.task_number ?? '—'}</span>
                      <span className="text-xs font-medium truncate flex-1">{t.title}</span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${t.status === 'in_progress' ? 'bg-blue-500/10 text-blue-400' : 'bg-secondary text-muted-foreground'}`}>
                        {t.status === 'in_progress' ? 'in progress' : 'pending'}
                      </span>
                      <ChevronRight className="w-3 h-3 text-muted-foreground/40 shrink-0 group-hover:translate-x-0.5 transition-transform" />
                    </Link>
                  ))}
                  {myActions.active.length > 6 && (
                    <Link href="/dashboard/tasks" className="block text-[11px] text-violet-400 hover:text-violet-300 px-2 pt-1">
                      +{myActions.active.length - 6} more in Tasks →
                    </Link>
                  )}
                </div>
              </div>
            </div>
          </div>
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
