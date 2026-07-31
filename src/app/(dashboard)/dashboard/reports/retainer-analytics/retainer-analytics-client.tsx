'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import type { ReadonlyURLSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import Header from '@/components/layout/header'
import {
  Handshake, TrendingUp, Wallet, Activity, Users2, Download, Printer, Search, ArrowLeft,
  FileSpreadsheet, FileText, SlidersHorizontal, X, AlertTriangle,
} from 'lucide-react'
import { STATUSES } from '@/lib/agreements/types'
import type { RetainerAnalytics, EmployeeRetainerRow, RetainerTrendPoint } from '@/lib/agreements/analytics'
import { forecastFromTrend, type RetainerForecast } from '@/lib/agreements/forecast'
import { smartInsights, agreementHealthScore, HEALTH_LABEL as BAND_LABEL, type Insight, type HealthBand } from '@/lib/agreements/intelligence'

// Charts are lazy — recharts (~95KB) loads only when the Executive tab renders.
const ChartSkeleton = () => <div className="h-[220px] rounded-lg bg-secondary/40 animate-pulse" />
const RevenueTrendChart = dynamic(() => import('./_retainer-charts').then(m => m.RevenueTrendChart), { ssr: false, loading: ChartSkeleton })
const MarginTrendChart = dynamic(() => import('./_retainer-charts').then(m => m.MarginTrendChart), { ssr: false, loading: ChartSkeleton })
const RevenueVsCostChart = dynamic(() => import('./_retainer-charts').then(m => m.RevenueVsCostChart), { ssr: false, loading: ChartSkeleton })
const UtilisationTrendChart = dynamic(() => import('./_retainer-charts').then(m => m.UtilisationTrendChart), { ssr: false, loading: ChartSkeleton })
const TopClientsChart = dynamic(() => import('./_retainer-charts').then(m => m.TopClientsChart), { ssr: false, loading: ChartSkeleton })

// ─── Formatting ──────────────────────────────────────────────────────────────
const inr = (n: number | null | undefined) => n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`
const money = (cur: string, n: number | null | undefined) => n == null ? '—' : `${cur} ${Math.round(n).toLocaleString('en-US')}`
const pct = (n: number | null | undefined) => n == null ? '—' : `${n}%`

const HEALTH_DOT: Record<string, string> = { green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500' }
const HEALTH_LABEL: Record<string, string> = { green: 'On track', amber: 'Near limit', red: 'Exceeded' }
const FIN_STYLE: Record<string, string> = {
  healthy: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  loss: 'text-red-600 dark:text-red-400',
}
const FIN_LABEL: Record<string, string> = { healthy: 'Healthy', warning: 'Warning', loss: 'Loss-making' }

function riskLevel(a: RetainerAnalytics, monthsToExpiry: number | null): { label: string; cls: string } {
  if (a.coverageHealth === 'red') return { label: 'High', cls: 'text-red-600 dark:text-red-400' }
  if (monthsToExpiry != null && monthsToExpiry <= 1) return { label: 'Renewal due', cls: 'text-amber-600 dark:text-amber-400' }
  if (a.coverageHealth === 'amber' || a.utilisation < 40) return { label: 'Watch', cls: 'text-amber-600 dark:text-amber-400' }
  return { label: 'Low', cls: 'text-emerald-600 dark:text-emerald-400' }
}

function nextInvoiceDate(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const nm = m === 12 ? 1 : m + 1
  const ny = m === 12 ? y + 1 : y
  return `${ny}-${String(nm).padStart(2, '0')}-01`
}

function monthsToExpiry(month: string, end: string | null): number | null {
  if (!end) return null
  const [y, m] = month.split('-').map(Number)
  const [ey, em] = end.split('-').map(Number)
  return (ey - y) * 12 + (em - m)
}

function monthsActiveThisYear(startDate: string | null, month: string): number {
  const [y, m] = month.split('-').map(Number)
  let startMonth = 1
  if (startDate) {
    const [sy, sm] = startDate.split('-').map(Number)
    if (sy > y) return 0
    if (sy === y) startMonth = sm
  }
  return Math.max(0, m - startMonth + 1)
}

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = rows.map(r => r.map(esc).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

// ─── Filters ─────────────────────────────────────────────────────────────────
interface Filters {
  q: string
  status: string   // 'all' | agreement status
  health: string   // 'all' | green | amber | red
  currency: string // 'all' | code
  country: string  // 'all' | country
  utilMin: string; utilMax: string
  marginMin: string; marginMax: string   // margin %
  revMin: string; revMax: string         // monthly retainer (INR)
}
const EMPTY_FILTERS: Filters = { q: '', status: 'all', health: 'all', currency: 'all', country: 'all', utilMin: '', utilMax: '', marginMin: '', marginMax: '', revMin: '', revMax: '' }

function initFilters(sp: ReadonlyURLSearchParams): Filters {
  const g = (k: keyof Filters) => sp.get(k) ?? EMPTY_FILTERS[k]
  return {
    q: g('q'), status: g('status'), health: g('health'), currency: g('currency'), country: g('country'),
    utilMin: g('utilMin'), utilMax: g('utilMax'), marginMin: g('marginMin'), marginMax: g('marginMax'),
    revMin: g('revMin'), revMax: g('revMax'),
  }
}

function applyFilters(rows: RetainerAnalytics[], f: Filters): RetainerAnalytics[] {
  const s = f.q.trim().toLowerCase()
  const num = (v: string) => v === '' ? null : Number(v)
  const uMin = num(f.utilMin), uMax = num(f.utilMax), mMin = num(f.marginMin), mMax = num(f.marginMax), rMin = num(f.revMin), rMax = num(f.revMax)
  return rows.filter(a => {
    if (s && !(a.clientName.toLowerCase().includes(s) || a.title.toLowerCase().includes(s) || a.agreementNumber.toLowerCase().includes(s))) return false
    if (f.status !== 'all' && a.status !== f.status) return false
    if (f.health !== 'all' && a.coverageHealth !== f.health) return false
    if (f.currency !== 'all' && a.currency !== f.currency) return false
    if (f.country !== 'all' && (a.country || 'Unknown') !== f.country) return false
    if (uMin != null && a.utilisation < uMin) return false
    if (uMax != null && a.utilisation > uMax) return false
    if (mMin != null && (a.marginPct ?? -Infinity) < mMin) return false
    if (mMax != null && (a.marginPct ?? Infinity) > mMax) return false
    if (rMin != null && (a.monthlyRetainerInr ?? 0) < rMin) return false
    if (rMax != null && (a.monthlyRetainerInr ?? 0) > rMax) return false
    return true
  })
}

function filterLabels(f: Filters): string[] {
  const out: string[] = []
  if (f.q) out.push(`Search "${f.q}"`)
  if (f.status !== 'all') out.push(`Status: ${f.status}`)
  if (f.health !== 'all') out.push(`Health: ${f.health}`)
  if (f.currency !== 'all') out.push(`Currency: ${f.currency}`)
  if (f.country !== 'all') out.push(`Country: ${f.country}`)
  if (f.utilMin || f.utilMax) out.push(`Utilisation ${f.utilMin || '0'}–${f.utilMax || '∞'}%`)
  if (f.marginMin || f.marginMax) out.push(`Margin ${f.marginMin || '−∞'}–${f.marginMax || '∞'}%`)
  if (f.revMin || f.revMax) out.push(`Revenue ₹${f.revMin || '0'}–${f.revMax || '∞'}`)
  return out
}

function hasActiveFilters(f: Filters): boolean {
  return Object.entries(f).some(([k, v]) => v !== EMPTY_FILTERS[k as keyof Filters])
}

function inDays(month: string, end: string | null, days: number): boolean {
  if (!end) return false
  const start = new Date(`${month}-01T00:00:00`)
  const e = new Date(`${end}T00:00:00`)
  const diff = (e.getTime() - start.getTime()) / 86400000
  return diff >= 0 && diff <= days
}

function groupSum(rows: RetainerAnalytics[], key: (a: RetainerAnalytics) => string, val: (a: RetainerAnalytics) => number): { name: string; value: number }[] {
  const m = new Map<string, number>()
  for (const a of rows) m.set(key(a), (m.get(key(a)) || 0) + val(a))
  return Array.from(m.entries()).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)
}

// One matrix per report, reused by CSV / Excel / PDF so exports always match
// the on-screen table + current filters.
function buildReport(
  tab: TabKey, rows: RetainerAnalytics[], employees: EmployeeRetainerRow[], month: string,
): { title: string; sheet: string; base: string; headers: string[]; body: (string | number)[][] } {
  switch (tab) {
    case 'revenue': return {
      title: 'Retainer Revenue', sheet: 'Revenue', base: `retainer-revenue-${month}`,
      headers: ['Client', 'Agreement', 'Monthly Retainer', 'Creative Allocation', 'Management Allocation', 'Month Revenue', 'Year Revenue', 'Status', 'Next Invoice', 'Expiry'],
      body: rows.map(a => [a.clientName, a.agreementNumber, a.monthlyRetainer ?? '', a.creativeAllocation ?? '', a.managementAllocation ?? '', a.monthlyRetainer ?? '', (a.monthlyRetainer ?? 0) * monthsActiveThisYear(a.startDate, month), a.status, nextInvoiceDate(month), a.endDate ?? 'Ongoing']),
    }
    case 'utilisation': return {
      title: 'Retainer Utilisation', sheet: 'Utilisation', base: `retainer-utilisation-${month}`,
      headers: ['Client', 'Agreement', 'Included', 'Delivered', 'Remaining', 'Extra', 'Utilisation %', 'Health'],
      body: rows.map(a => [a.clientName, a.agreementNumber, a.included, a.delivered, a.remaining, a.extraTasks, a.utilisation, HEALTH_LABEL[a.coverageHealth]]),
    }
    case 'profitability': return {
      title: 'Retainer Profitability', sheet: 'Profitability', base: `retainer-profitability-${month}`,
      headers: ['Client', 'Retainer (INR)', 'Creative (INR)', 'Internal Cost (INR)', 'Gross Margin (INR)', 'Margin %', 'Financial Health'],
      body: rows.map(a => [a.clientName, a.monthlyRetainerInr ?? '', a.creativeAllocationInr ?? '', a.internalCost ?? '', a.grossMargin ?? '', a.marginPct ?? '', a.financialHealth ? FIN_LABEL[a.financialHealth] : '']),
    }
    case 'health': return {
      title: 'Agreement Health', sheet: 'Health', base: `retainer-health-${month}`,
      headers: ['Agreement', 'Client', 'Status', 'Expiry', 'Utilisation %', 'Remaining', 'Next Invoice', 'Health', 'Risk'],
      body: rows.map(a => [a.agreementNumber, a.clientName, a.status, a.endDate ?? 'Ongoing', a.utilisation, a.remaining, nextInvoiceDate(month), HEALTH_LABEL[a.coverageHealth], riskLevel(a, monthsToExpiry(month, a.endDate)).label]),
    }
    case 'employees': return {
      title: 'Employee Contribution', sheet: 'Employees', base: `employee-contribution-${month}`,
      headers: ['Employee', 'Tasks', 'Avg Contribution %', 'Internal Cost (INR)', 'Allocated Value (INR)', 'Efficiency', 'Top Clients'],
      body: employees.map(e => [e.employeeName, e.tasks, e.avgContribution, e.internalCost ?? '', e.allocatedValueProduced ?? '', e.efficiency ?? '', e.topClients.join(' / ')]),
    }
    default: return { title: 'Retainer', sheet: 'Retainer', base: `retainer-${month}`, headers: [], body: [] }
  }
}

type TabKey = 'exec' | 'revenue' | 'utilisation' | 'profitability' | 'health' | 'employees'
const TABS: { key: TabKey; label: string; pricing?: boolean }[] = [
  { key: 'exec', label: 'Executive' },
  { key: 'revenue', label: 'Revenue', pricing: true },
  { key: 'utilisation', label: 'Utilisation' },
  { key: 'profitability', label: 'Profitability', pricing: true },
  { key: 'health', label: 'Health' },
  { key: 'employees', label: 'Employees' },
]

export default function RetainerAnalyticsClient({
  analytics, employees, trend, month, range, canViewPricing,
}: {
  analytics: RetainerAnalytics[]
  employees: EmployeeRetainerRow[]
  trend: RetainerTrendPoint[]
  month: string
  range: number
  canViewPricing: boolean
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [tab, setTab] = useState<TabKey>('exec')
  const [filters, setFilters] = useState<Filters>(() => initFilters(searchParams))

  // Filter options derived from the loaded data.
  const currencies = useMemo(() => Array.from(new Set(analytics.map(a => a.currency))).sort(), [analytics])
  const countries = useMemo(() => Array.from(new Set(analytics.map(a => a.country).filter(Boolean) as string[])).sort(), [analytics])

  // Dimensional filters are applied CLIENT-SIDE to the loaded month's rows (the
  // server already did the heavy aggregation). Month/range stay server-driven.
  const filtered = useMemo(() => applyFilters(analytics, filters), [analytics, filters])
  const rows = filtered

  const exec = useMemo(() => {
    const totalRevenue = filtered.reduce((s, a) => s + (a.monthlyRetainerInr ?? 0), 0)
    const totalCreative = filtered.reduce((s, a) => s + (a.creativeAllocationInr ?? 0), 0)
    const totalCost = filtered.reduce((s, a) => s + (a.internalCost ?? 0), 0)
    const totalMargin = filtered.reduce((s, a) => s + (a.grossMargin ?? 0), 0)
    const avgUtil = filtered.length ? Math.round(filtered.reduce((s, a) => s + a.utilisation, 0) / filtered.length) : 0
    const exp30 = filtered.filter(a => inDays(month, a.endDate, 30)).length
    const exp60 = filtered.filter(a => inDays(month, a.endDate, 60)).length
    const exp90 = filtered.filter(a => inDays(month, a.endDate, 90)).length
    const avgRevPerClient = filtered.length ? Math.round(totalRevenue / new Set(filtered.map(a => a.clientId)).size) : 0
    const avgMargin = filtered.filter(a => a.marginPct != null).length
      ? Math.round(filtered.filter(a => a.marginPct != null).reduce((s, a) => s + (a.marginPct ?? 0), 0) / filtered.filter(a => a.marginPct != null).length) : 0
    return { totalRevenue, totalCreative, totalCost, totalMargin, avgUtil, expiring: exp30, exp30, exp60, exp90, avgRevPerClient, avgMargin, count: filtered.length, clients: new Set(filtered.map(a => a.clientId)).size }
  }, [filtered, month])

  const byRevenue = useMemo(() => [...filtered].sort((a, b) => (b.monthlyRetainerInr ?? 0) - (a.monthlyRetainerInr ?? 0)).slice(0, 10), [filtered])
  const byMargin = useMemo(() => [...filtered].filter(a => a.grossMargin != null).sort((a, b) => (b.grossMargin ?? 0) - (a.grossMargin ?? 0)).slice(0, 10), [filtered])
  const mostUtil = useMemo(() => [...filtered].sort((a, b) => b.utilisation - a.utilisation).slice(0, 5), [filtered])
  const leastUtil = useMemo(() => [...filtered].sort((a, b) => a.utilisation - b.utilisation).slice(0, 5), [filtered])
  const topRisk = useMemo(() => [...filtered].filter(a => a.coverageHealth === 'red' || a.utilisation < 40 || inDays(month, a.endDate, 60)).slice(0, 5), [filtered, month])
  const topEmployees = useMemo(() => [...employees].slice(0, 10), [employees])

  // Distribution by currency + country (revenue INR).
  const byCurrency = useMemo(() => groupSum(filtered, a => a.currency, a => a.monthlyRetainerInr ?? 0), [filtered])
  const byCountry = useMemo(() => groupSum(filtered, a => a.country || 'Unknown', a => a.monthlyRetainerInr ?? 0), [filtered])

  // Operational intelligence (Phase 4) — pure functions over the loaded engines.
  const forecast = useMemo(() => forecastFromTrend(trend, canViewPricing), [trend, canViewPricing])
  const insights = useMemo(() => smartInsights(filtered, trend, month).filter(i => !i.pricing || canViewPricing), [filtered, trend, month, canViewPricing])
  const byHealth = useMemo(() =>
    filtered.map(a => ({ a, h: agreementHealthScore(a, month) })).sort((x, y) => x.h.score - y.h.score),
    [filtered, month])
  const atRisk = useMemo(() => byHealth.filter(x => x.h.band === 'at_risk' || x.h.band === 'critical' || x.h.band === 'watch').slice(0, 6), [byHealth])

  function updateFilters(patch: Partial<Filters>) {
    const next = { ...filters, ...patch }
    setFilters(next)
    const p = new URLSearchParams()
    p.set('month', month); p.set('range', String(range))
    for (const [k, v] of Object.entries(next)) if (v && v !== 'all' && v !== '') p.set(k, String(v))
    router.replace(`/dashboard/reports/retainer-analytics?${p.toString()}`, { scroll: false })
  }
  const activeFilterLabels = filterLabels(filters)

  const [exporting, setExporting] = useState(false)
  async function doExport(fmt: 'csv' | 'xlsx' | 'pdf') {
    const rep = buildReport(tab, rows, employees, month)
    if (rep.headers.length === 0) return
    if (fmt === 'csv') {
      downloadCsv(`${rep.base}.csv`, [rep.headers, ...rep.body])
      return
    }
    setExporting(true)
    try {
      const mod = await import('./_exports')
      if (fmt === 'xlsx') {
        await mod.exportXlsx({ filename: `${rep.base}.xlsx`, sheetName: rep.sheet, headers: rep.headers, rows: rep.body })
      } else {
        const kpis = canViewPricing
          ? [
              { label: 'Revenue', value: inr(exec.totalRevenue) },
              { label: 'Gross margin', value: inr(exec.totalMargin) },
              { label: 'Avg utilisation', value: `${exec.avgUtil}%` },
              { label: 'Active retainers', value: String(exec.count) },
            ]
          : [{ label: 'Avg utilisation', value: `${exec.avgUtil}%` }, { label: 'Active retainers', value: String(exec.count) }]
        await mod.exportPdf({
          filename: `${rep.base}.pdf`, title: `${rep.title} — ${month}`,
          subtitle: 'Cirqle Works · Retainer Analytics',
          generatedAt: new Date().toLocaleString(),
          filters: activeFilterLabels.length ? activeFilterLabels : ['None'],
          kpis, headers: rep.headers, rows: rep.body,
        })
      }
    } finally { setExporting(false) }
  }

  const setMonth = (m: string) => router.push(`/dashboard/reports/retainer-analytics?month=${m}&range=${range}`)
  const setRange = (r: number) => router.push(`/dashboard/reports/retainer-analytics?month=${month}&range=${r}`)

  const visibleTabs = TABS.filter(t => !t.pricing || canViewPricing)

  return (
    <div className="min-h-screen pb-20">
      <Header title="Retainer Analytics" subtitle="Management reporting — revenue, utilisation, profitability & production." />
      <div className="px-4 sm:px-6 lg:px-8 max-w-[1400px] mx-auto mt-6 space-y-5">

        <Link href="/dashboard/reports" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> All reports
        </Link>

        {/* Toolbar */}
        <div className="flex flex-col sm:flex-row gap-3 sm:items-center justify-between print:hidden">
          <div className="flex items-center gap-2 flex-wrap">
            {visibleTabs.map(t => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`text-sm font-medium px-3 py-1.5 rounded-lg border transition-colors ${tab === t.key ? 'bg-primary/10 text-primary border-primary/30' : 'bg-secondary text-muted-foreground border-transparent hover:text-foreground'}`}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)}
              className="bg-secondary border border-foreground/15 rounded-lg px-2.5 py-1.5 text-sm" />
            {tab !== 'exec' && (
              <>
                <button onClick={() => doExport('csv')} title="Export CSV" className="inline-flex items-center gap-1.5 text-xs px-2.5 py-2 rounded-lg bg-secondary border border-border hover:bg-secondary/70">
                  <Download className="w-3.5 h-3.5" /> CSV
                </button>
                <button onClick={() => doExport('xlsx')} disabled={exporting} title="Export Excel" className="inline-flex items-center gap-1.5 text-xs px-2.5 py-2 rounded-lg bg-secondary border border-border hover:bg-secondary/70 disabled:opacity-50">
                  <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
                </button>
                <button onClick={() => doExport('pdf')} disabled={exporting} title="Export PDF" className="inline-flex items-center gap-1.5 text-xs px-2.5 py-2 rounded-lg bg-secondary border border-border hover:bg-secondary/70 disabled:opacity-50">
                  <FileText className="w-3.5 h-3.5" /> PDF
                </button>
                <button onClick={() => window.print()} title="Print" className="inline-flex items-center gap-1.5 text-xs px-2.5 py-2 rounded-lg bg-secondary border border-border hover:bg-secondary/70">
                  <Printer className="w-3.5 h-3.5" /> Print
                </button>
              </>
            )}
          </div>
        </div>

        {/* Advanced filters */}
        {analytics.length > 0 && tab !== 'employees' && (
          <FilterBar filters={filters} update={updateFilters} clear={() => updateFilters(EMPTY_FILTERS)}
            currencies={currencies} countries={countries} canViewPricing={canViewPricing}
            activeLabels={activeFilterLabels} shown={filtered.length} total={analytics.length} />
        )}

        {analytics.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-muted/30 py-16 text-center text-muted-foreground">
            No active retainer agreements for {month}.
          </div>
        ) : tab === 'exec' ? (
          <Executive exec={exec} canViewPricing={canViewPricing} byRevenue={byRevenue} byMargin={byMargin}
            mostUtil={mostUtil} leastUtil={leastUtil} topRisk={topRisk} topEmployees={topEmployees}
            byCurrency={byCurrency} byCountry={byCountry} trend={trend} range={range} setRange={setRange} month={month}
            forecast={forecast} insights={insights} atRisk={atRisk} />
        ) : (
          <ReportTable tab={tab} rows={rows} employees={employees} month={month} />
        )}
      </div>
    </div>
  )
}

// ─── Executive dashboard ─────────────────────────────────────────────────────
interface ExecSummary {
  totalRevenue: number; totalCreative: number; totalCost: number; totalMargin: number
  avgUtil: number; expiring: number; exp30: number; exp60: number; exp90: number
  avgRevPerClient: number; avgMargin: number; count: number; clients: number
}
function Executive({
  exec, canViewPricing, byRevenue, byMargin, mostUtil, leastUtil, topRisk, topEmployees,
  byCurrency, byCountry, trend, range, setRange, month, forecast, insights, atRisk,
}: {
  exec: ExecSummary
  canViewPricing: boolean
  byRevenue: RetainerAnalytics[]; byMargin: RetainerAnalytics[]
  mostUtil: RetainerAnalytics[]; leastUtil: RetainerAnalytics[]; topRisk: RetainerAnalytics[]
  topEmployees: EmployeeRetainerRow[]
  byCurrency: { name: string; value: number }[]; byCountry: { name: string; value: number }[]
  trend: RetainerTrendPoint[]; range: number; setRange: (r: number) => void; month: string
  forecast: RetainerForecast; insights: Insight[]; atRisk: { a: RetainerAnalytics; h: { score: number; band: HealthBand } }[]
}) {
  const cards: { label: string; value: string; icon: typeof Wallet; tone?: string }[] = [
    { label: 'Active retainers', value: String(exec.count), icon: Handshake },
    { label: 'Active clients', value: String(exec.clients), icon: Users2 },
    { label: 'Avg utilisation', value: `${exec.avgUtil}%`, icon: Activity },
    { label: 'Expiring ≤30d', value: String(exec.exp30), icon: AlertTriangle, tone: exec.exp30 > 0 ? 'text-amber-600 dark:text-amber-400' : '' },
  ]
  if (canViewPricing) {
    cards.unshift({ label: 'Monthly retainer revenue', value: inr(exec.totalRevenue), icon: Wallet })
    cards.push(
      { label: 'Est. gross margin', value: inr(exec.totalMargin), icon: TrendingUp, tone: exec.totalMargin < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400' },
      { label: 'Avg margin', value: `${exec.avgMargin}%`, icon: TrendingUp },
      { label: 'Avg revenue / client', value: inr(exec.avgRevPerClient), icon: Wallet },
    )
  }
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cards.map(c => (
          <div key={c.label} className="bg-card border border-border rounded-2xl p-5">
            <div className="flex items-center gap-2 text-muted-foreground mb-2"><c.icon className="w-4 h-4" /><span className="text-xs">{c.label}</span></div>
            <div className={`text-2xl font-bold tabular-nums ${c.tone || ''}`}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Renewal / expiry timeline */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Expiring ≤ 30 days', value: exec.exp30 },
          { label: 'Expiring ≤ 60 days', value: exec.exp60 },
          { label: 'Expiring ≤ 90 days', value: exec.exp90 },
        ].map(x => (
          <div key={x.label} className="bg-card border border-border rounded-2xl p-4 text-center">
            <div className={`text-2xl font-bold tabular-nums ${x.value > 0 ? 'text-amber-600 dark:text-amber-400' : ''}`}>{x.value}</div>
            <div className="text-[11px] text-muted-foreground mt-1">{x.label}</div>
          </div>
        ))}
      </div>

      {/* Operational intelligence — forecast + insights (Phase 4) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <ForecastCard forecast={forecast} canViewPricing={canViewPricing} />
        <InsightsCard insights={insights} />
      </div>
      {atRisk.length > 0 && (
        <TopList title="Clients needing attention" icon={AlertTriangle}
          rows={atRisk.map(x => ({ label: x.a.clientName, sub: `${x.a.agreementNumber} · health ${x.h.score}`, value: BAND_LABEL[x.h.band], dot: x.a.coverageHealth }))} />
      )}

      {/* Trend charts */}
      <div className="flex items-center justify-between print:hidden">
        <h3 className="text-sm font-semibold text-muted-foreground">Trends</h3>
        <div className="flex items-center gap-1">
          {[3, 6, 12].map(r => (
            <button key={r} onClick={() => setRange(r)}
              className={`text-xs font-medium px-2.5 py-1 rounded-lg border transition-colors ${range === r ? 'bg-primary/10 text-primary border-primary/30' : 'bg-secondary text-muted-foreground border-transparent hover:text-foreground'}`}>
              {r}M
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {canViewPricing && (
          <ChartCard title="Monthly revenue trend"><RevenueTrendChart data={trend} /></ChartCard>
        )}
        <ChartCard title="Utilisation trend"><UtilisationTrendChart data={trend} /></ChartCard>
        {canViewPricing && (
          <ChartCard title="Gross margin trend"><MarginTrendChart data={trend} /></ChartCard>
        )}
        {canViewPricing && (
          <ChartCard title="Revenue vs internal cost"><RevenueVsCostChart data={trend} /></ChartCard>
        )}
        {canViewPricing && byRevenue.length > 0 && (
          <ChartCard title="Top revenue clients">
            <TopClientsChart data={byRevenue.slice(0, 8).map(a => ({ name: a.clientName, value: a.monthlyRetainerInr ?? 0 }))} />
          </ChartCard>
        )}
      </div>

      {/* Distribution (revenue by currency / country) */}
      {canViewPricing && (byCurrency.length > 1 || byCountry.length > 1) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {byCurrency.length > 1 && <ChartCard title="Revenue by currency"><TopClientsChart data={byCurrency} /></ChartCard>}
          {byCountry.length > 1 && <ChartCard title="Revenue by country"><TopClientsChart data={byCountry} /></ChartCard>}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {canViewPricing && <TopList title="Top revenue clients" rows={byRevenue.map(a => ({ label: a.clientName, sub: a.agreementNumber, value: inr(a.monthlyRetainerInr) }))} />}
        {canViewPricing && <TopList title="Top margin clients" rows={byMargin.map(a => ({ label: a.clientName, sub: `${a.marginPct ?? 0}%`, value: inr(a.grossMargin) }))} />}
        <TopList title="Most utilised agreements" rows={mostUtil.map(a => ({ label: a.clientName, sub: a.agreementNumber, value: `${a.utilisation}%`, dot: a.coverageHealth }))} />
        <TopList title="Least utilised agreements" rows={leastUtil.map(a => ({ label: a.clientName, sub: a.agreementNumber, value: `${a.utilisation}%`, dot: a.coverageHealth }))} />
        <TopList title="Highest-risk agreements" icon={AlertTriangle}
          rows={topRisk.map(a => ({ label: a.clientName, sub: a.agreementNumber, value: riskLevel(a, monthsToExpiry(month, a.endDate)).label, dot: a.coverageHealth }))} />
        {topEmployees.length > 0 && (
          <TopList title="Top employees (retainer work)" icon={Users2}
            rows={topEmployees.map(e => ({ label: e.employeeName, sub: `${e.tasks} tasks`, value: canViewPricing ? inr(e.allocatedValueProduced) : `${e.avgContribution}%` }))} />
        )}
      </div>
    </div>
  )
}

const CONF_STYLE: Record<string, string> = {
  high: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400 border-emerald-500/25',
  medium: 'bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/25',
  low: 'bg-secondary text-muted-foreground border-border',
}
function ForecastCard({ forecast: f, canViewPricing }: { forecast: RetainerForecast; canViewPricing: boolean }) {
  const cells: { label: string; value: string }[] = []
  if (canViewPricing) {
    cells.push(
      { label: 'Next-month revenue', value: inr(f.nextMonthRevenue) },
      { label: 'Quarter revenue', value: inr(f.quarterRevenue) },
      { label: 'Annual run-rate', value: inr(f.annualRevenue) },
      { label: 'Expected margin', value: inr(f.nextMonthMargin) },
    )
  }
  cells.push(
    { label: 'Expected utilisation', value: f.expectedUtilisation != null ? `${f.expectedUtilisation}%` : '—' },
    { label: 'Expected delivered', value: f.expectedDelivered != null ? String(f.expectedDelivered) : '—' },
  )
  return (
    <div className="bg-card border border-border rounded-2xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold flex items-center gap-1.5"><TrendingUp className="w-4 h-4 text-muted-foreground" /> Forecast</h4>
        <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border ${CONF_STYLE[f.confidence]}`}>{f.confidence} confidence</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {cells.map(c => (
          <div key={c.label}><div className="text-[10px] text-muted-foreground">{c.label}</div><div className="text-sm font-semibold tabular-nums">{c.value}</div></div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground mt-3">Linear projection from {f.basisMonths} month(s) of trend data — directional, not a commitment.</p>
    </div>
  )
}

const PRIO_DOT: Record<string, string> = { high: 'bg-red-500', medium: 'bg-amber-500', low: 'bg-emerald-500' }
function InsightsCard({ insights }: { insights: Insight[] }) {
  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      <div className="px-5 py-3 border-b border-border/60 text-sm font-semibold flex items-center gap-1.5"><Activity className="w-4 h-4 text-muted-foreground" /> Smart insights</div>
      {insights.length === 0 ? (
        <div className="px-5 py-6 text-sm text-muted-foreground text-center">Nothing needs attention right now.</div>
      ) : (
        <div className="divide-y divide-border/40 max-h-[320px] overflow-y-auto">
          {insights.slice(0, 12).map(i => (
            <div key={i.key} className="px-5 py-3 flex gap-3">
              <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${PRIO_DOT[i.priority]}`} />
              <div className="min-w-0">
                <p className="text-sm font-medium">{i.title}</p>
                <p className="text-[11px] text-muted-foreground">{i.reason}</p>
                <p className="text-[11px] text-primary mt-0.5">→ {i.recommendation}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-2xl p-5">
      <h4 className="text-sm font-semibold mb-3">{title}</h4>
      {children}
    </div>
  )
}

function TopList({ title, rows, icon: Icon }: { title: string; rows: { label: string; sub: string; value: string; dot?: string }[]; icon?: typeof Wallet }) {
  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      <div className="px-5 py-3 border-b border-border/60 text-sm font-semibold flex items-center gap-1.5">
        {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}{title}
      </div>
      {rows.length === 0 ? (
        <div className="px-5 py-6 text-sm text-muted-foreground text-center">No data</div>
      ) : (
        <div className="divide-y divide-border/40">
          {rows.map((r, i) => (
            <div key={i} className="px-5 py-2.5 flex items-center gap-3">
              <span className="text-xs text-muted-foreground w-4 tabular-nums">{i + 1}</span>
              {r.dot && <span className={`w-2 h-2 rounded-full ${HEALTH_DOT[r.dot]}`} />}
              <div className="min-w-0 flex-1"><div className="text-sm font-medium truncate">{r.label}</div><div className="text-[11px] text-muted-foreground">{r.sub}</div></div>
              <div className="text-sm font-semibold tabular-nums">{r.value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Filter bar ──────────────────────────────────────────────────────────────
function FilterBar({
  filters, update, clear, currencies, countries, canViewPricing, activeLabels, shown, total,
}: {
  filters: Filters
  update: (patch: Partial<Filters>) => void
  clear: () => void
  currencies: string[]; countries: string[]; canViewPricing: boolean
  activeLabels: string[]; shown: number; total: number
}) {
  const [open, setOpen] = useState(false)
  const active = hasActiveFilters(filters)
  const sel = 'bg-secondary border border-foreground/15 rounded-lg px-2.5 py-1.5 text-sm'
  const numInput = 'bg-secondary border border-foreground/15 rounded-lg px-2 py-1.5 text-sm w-20'
  return (
    <div className="rounded-xl border border-border bg-card p-3 print:hidden">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input value={filters.q} onChange={e => update({ q: e.target.value })} placeholder="Search client, agreement…"
            className="w-full bg-secondary border border-foreground/15 rounded-lg pl-9 pr-3 py-2 text-sm" />
        </div>
        <select value={filters.status} onChange={e => update({ status: e.target.value })} className={sel}>
          <option value="all">All statuses</option>
          {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={filters.health} onChange={e => update({ health: e.target.value })} className={sel}>
          <option value="all">All health</option>
          <option value="green">On track</option><option value="amber">Near limit</option><option value="red">Exceeded</option>
        </select>
        <button onClick={() => setOpen(o => !o)}
          className={`inline-flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded-lg border transition-colors ${open || active ? 'bg-primary/10 text-primary border-primary/30' : 'bg-secondary text-muted-foreground border-border'}`}>
          <SlidersHorizontal className="w-3.5 h-3.5" /> More
        </button>
        {active && (
          <button onClick={clear} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <X className="w-3.5 h-3.5" /> Clear
          </button>
        )}
        <span className="text-xs text-muted-foreground ml-auto">{shown} of {total}</span>
      </div>

      {open && (
        <div className="mt-3 pt-3 border-t border-border/60 flex flex-wrap items-center gap-x-4 gap-y-2">
          {currencies.length > 1 && (
            <label className="text-xs text-muted-foreground flex items-center gap-1.5">Currency
              <select value={filters.currency} onChange={e => update({ currency: e.target.value })} className={sel}>
                <option value="all">All</option>{currencies.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          )}
          {countries.length > 0 && (
            <label className="text-xs text-muted-foreground flex items-center gap-1.5">Country
              <select value={filters.country} onChange={e => update({ country: e.target.value })} className={sel}>
                <option value="all">All</option>{countries.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          )}
          <label className="text-xs text-muted-foreground flex items-center gap-1.5">Utilisation %
            <input type="number" value={filters.utilMin} onChange={e => update({ utilMin: e.target.value })} placeholder="min" className={numInput} />
            <input type="number" value={filters.utilMax} onChange={e => update({ utilMax: e.target.value })} placeholder="max" className={numInput} />
          </label>
          {canViewPricing && (
            <>
              <label className="text-xs text-muted-foreground flex items-center gap-1.5">Margin %
                <input type="number" value={filters.marginMin} onChange={e => update({ marginMin: e.target.value })} placeholder="min" className={numInput} />
                <input type="number" value={filters.marginMax} onChange={e => update({ marginMax: e.target.value })} placeholder="max" className={numInput} />
              </label>
              <label className="text-xs text-muted-foreground flex items-center gap-1.5">Revenue ₹
                <input type="number" value={filters.revMin} onChange={e => update({ revMin: e.target.value })} placeholder="min" className={numInput} />
                <input type="number" value={filters.revMax} onChange={e => update({ revMax: e.target.value })} placeholder="max" className={numInput} />
              </label>
            </>
          )}
        </div>
      )}

      {activeLabels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {activeLabels.map((l, i) => (
            <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">{l}</span>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Report tables ───────────────────────────────────────────────────────────
function ReportTable({
  tab, rows, employees, month,
}: {
  tab: TabKey; rows: RetainerAnalytics[]; employees: EmployeeRetainerRow[]; month: string
}) {
  const th = 'px-4 py-3 font-medium'
  const td = 'px-4 py-3'
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          {tab === 'revenue' && (
            <>
              <thead className="bg-muted/50 text-muted-foreground border-b text-xs uppercase">
                <tr><th className={th}>Client</th><th className={th}>Agreement</th><th className={th}>Monthly</th><th className={th}>Creative</th><th className={th}>Mgmt</th><th className={th}>Month Rev</th><th className={th}>Year Rev</th><th className={th}>Status</th><th className={th}>Next Invoice</th><th className={th}>Expiry</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map(a => (
                  <tr key={a.agreementId} className="hover:bg-muted/30">
                    <td className={td}>{a.clientName}</td>
                    <td className={td}><Link href={`/dashboard/agreements/${a.agreementId}`} className="text-primary hover:underline">{a.agreementNumber}</Link></td>
                    <td className={td + ' tabular-nums'}>{money(a.currency, a.monthlyRetainer)}</td>
                    <td className={td + ' tabular-nums'}>{money(a.currency, a.creativeAllocation)}</td>
                    <td className={td + ' tabular-nums'}>{money(a.currency, a.managementAllocation)}</td>
                    <td className={td + ' tabular-nums'}>{money(a.currency, a.monthlyRetainer)}</td>
                    <td className={td + ' tabular-nums'}>{money(a.currency, a.monthlyRetainer != null ? a.monthlyRetainer * monthsActiveThisYear(a.startDate, month) : null)}</td>
                    <td className={td + ' capitalize'}>{a.status}</td>
                    <td className={td + ' text-muted-foreground'}>{nextInvoiceDate(month)}</td>
                    <td className={td + ' text-muted-foreground'}>{a.endDate ?? 'Ongoing'}</td>
                  </tr>
                ))}
              </tbody>
            </>
          )}

          {tab === 'utilisation' && (
            <>
              <thead className="bg-muted/50 text-muted-foreground border-b text-xs uppercase">
                <tr><th className={th}>Client</th><th className={th}>Agreement</th><th className={th}>Included</th><th className={th}>Delivered</th><th className={th}>Remaining</th><th className={th}>Extra</th><th className={th}>Utilisation</th><th className={th}>Health</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map(a => (
                  <tr key={a.agreementId} className="hover:bg-muted/30">
                    <td className={td}>{a.clientName}</td>
                    <td className={td}><Link href={`/dashboard/agreements/${a.agreementId}`} className="text-primary hover:underline">{a.agreementNumber}</Link></td>
                    <td className={td + ' tabular-nums'}>{a.included}</td>
                    <td className={td + ' tabular-nums'}>{a.delivered}</td>
                    <td className={td + ' tabular-nums'}>{a.remaining}</td>
                    <td className={td + ' tabular-nums'}>{a.extraTasks || '—'}</td>
                    <td className={td + ' tabular-nums font-semibold'}>{pct(a.utilisation)}</td>
                    <td className={td}><span className="inline-flex items-center gap-1.5 text-xs"><span className={`w-2 h-2 rounded-full ${HEALTH_DOT[a.coverageHealth]}`} />{HEALTH_LABEL[a.coverageHealth]}</span></td>
                  </tr>
                ))}
              </tbody>
            </>
          )}

          {tab === 'profitability' && (
            <>
              <thead className="bg-muted/50 text-muted-foreground border-b text-xs uppercase">
                <tr><th className={th}>Client</th><th className={th}>Retainer (INR)</th><th className={th}>Creative (INR)</th><th className={th}>Internal Cost</th><th className={th}>Gross Margin</th><th className={th}>Margin %</th><th className={th}>Financial Health</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map(a => (
                  <tr key={a.agreementId} className="hover:bg-muted/30">
                    <td className={td}>{a.clientName}</td>
                    <td className={td + ' tabular-nums'}>{inr(a.monthlyRetainerInr)}</td>
                    <td className={td + ' tabular-nums'}>{inr(a.creativeAllocationInr)}</td>
                    <td className={td + ' tabular-nums'}>{inr(a.internalCost)}</td>
                    <td className={td + ' tabular-nums font-semibold'}>{inr(a.grossMargin)}</td>
                    <td className={td + ' tabular-nums'}>{pct(a.marginPct)}</td>
                    <td className={td}>{a.financialHealth ? <span className={FIN_STYLE[a.financialHealth]}>{FIN_LABEL[a.financialHealth]}</span> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </>
          )}

          {tab === 'health' && (
            <>
              <thead className="bg-muted/50 text-muted-foreground border-b text-xs uppercase">
                <tr><th className={th}>Agreement</th><th className={th}>Client</th><th className={th}>Status</th><th className={th}>Expiry</th><th className={th}>Usage</th><th className={th}>Remaining</th><th className={th}>Next Invoice</th><th className={th}>Health</th><th className={th}>Risk</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map(a => {
                  const risk = riskLevel(a, monthsToExpiry(month, a.endDate))
                  return (
                    <tr key={a.agreementId} className="hover:bg-muted/30">
                      <td className={td}><Link href={`/dashboard/agreements/${a.agreementId}`} className="text-primary hover:underline">{a.agreementNumber}</Link></td>
                      <td className={td}>{a.clientName}</td>
                      <td className={td + ' capitalize'}>{a.status}</td>
                      <td className={td + ' text-muted-foreground'}>{a.endDate ?? 'Ongoing'}</td>
                      <td className={td + ' tabular-nums'}>{a.delivered}/{a.included} · {pct(a.utilisation)}</td>
                      <td className={td + ' tabular-nums'}>{a.remaining}</td>
                      <td className={td + ' text-muted-foreground'}>{nextInvoiceDate(month)}</td>
                      <td className={td}><span className="inline-flex items-center gap-1.5 text-xs"><span className={`w-2 h-2 rounded-full ${HEALTH_DOT[a.coverageHealth]}`} />{HEALTH_LABEL[a.coverageHealth]}</span></td>
                      <td className={td}><span className={risk.cls}>{risk.label}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </>
          )}

          {tab === 'employees' && (
            <>
              <thead className="bg-muted/50 text-muted-foreground border-b text-xs uppercase">
                <tr><th className={th}>Employee</th><th className={th}>Tasks</th><th className={th}>Avg Contribution</th><th className={th}>Internal Cost</th><th className={th}>Allocated Value</th><th className={th}>Efficiency</th><th className={th}>Top Clients</th></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {employees.length === 0 ? (
                  <tr><td className={td + ' text-muted-foreground'} colSpan={7}>No retainer contributions this month.</td></tr>
                ) : employees.map(e => (
                  <tr key={e.employeeId} className="hover:bg-muted/30">
                    <td className={td + ' font-medium'}>{e.employeeName}</td>
                    <td className={td + ' tabular-nums'}>{e.tasks}</td>
                    <td className={td + ' tabular-nums'}>{pct(e.avgContribution)}</td>
                    <td className={td + ' tabular-nums'}>{inr(e.internalCost)}</td>
                    <td className={td + ' tabular-nums'}>{inr(e.allocatedValueProduced)}</td>
                    <td className={td + ' tabular-nums font-semibold'}>{e.efficiency != null ? `${e.efficiency}×` : '—'}</td>
                    <td className={td + ' text-muted-foreground text-xs'}>{e.topClients.join(' · ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </>
          )}
        </table>
      </div>
    </div>
  )
}
