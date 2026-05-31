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

import { useState, useMemo, use, Suspense, useEffect } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { DateFilter, matchesDateFilter, getDateFilterLabel } from '@/components/ui/date-filter'
import type { DateFilterValue } from '@/components/ui/date-filter'
import {
  AlertTriangle, ClipboardList, ArrowRight, CheckCircle, X, ChevronRight,
  FileText, BarChart3,
} from 'lucide-react'
import {
  fmt, fmtDate, daysLate, daysToGo, getPeriodKey, getPeriodLabel,
  StatusBadge, ContributionActivityBar,
} from './dashboard-utils'
import type { Granularity, DrawerType } from './dashboard-utils'
import DashboardAnalytics from './dashboard-analytics'

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
  allCashbook: any[]; displayTasks: any[]; allAnalyticsTasksPromise: Promise<any[]>
  todayTasks: any[]; unscoredDoneTasks: any[]; activeTasks: any[]; toBeInvoiced: any[]
  employees: any[]; scoresPromise: Promise<any[]>; payrollRecords: any[]
  pendingContribCount?: number
  todayStr: string
  isAdmin?: boolean
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
  todayStr,
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

        {/* ── Streamed analytics (KPIs · Production · Pulse · bottom grid) ──── */}
        {/* These read the two heavy promises via use(); the shell above already
            painted. The fallback mirrors the real section's dimensions. */}
        <Suspense fallback={<AnalyticsSkeleton />}>
          <DashboardAnalytics
            allAnalyticsTasksPromise={allAnalyticsTasksPromise}
            scoresPromise={scoresPromise}
            stats={stats}
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
          />
        </Suspense>
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
}: {
  todayStr: string; scoresPromise: Promise<any[]>; payrollRecords: any[]; pendingContribCount?: number
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
