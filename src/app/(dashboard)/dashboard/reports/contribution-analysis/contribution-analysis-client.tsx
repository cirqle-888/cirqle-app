'use client'

import { useState, useMemo, useEffect, useRef, useCallback, Fragment } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import Header from '@/components/layout/header'
import { usePrivacy } from '@/contexts/privacy-context'
import {
  applyFilters, sortRows, computeSummary, toMatrix, matrixToCSV, empShare,
  EMPTY_FILTERS, type Filters, type AnalysisRow, type EmployeeColumn,
  type SortKey, type SortDir,
} from '@/lib/reports/contribution-analysis'
import {
  Download, Printer, FileSpreadsheet, SlidersHorizontal, X, ArrowUp, ArrowDown,
  ChevronLeft, ChevronRight,
} from 'lucide-react'

interface Props {
  rows: AnalysisRow[]
  employees: EmployeeColumn[]
  clients: { id: string; name: string }[]
  services: { id: string; name: string }[]
}

const STATUSES = ['pending', 'in_progress', 'done', 'delivered', 'invoiced', 'paid', 'cancelled']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ROW_H = 38
const PAGE_SIZES = [50, 100, 250, 1000, 0] // 0 = All

const fmt = (n: number, dp = 2) =>
  n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: dp })
const inr = (n: number, dp = 0) => '₹' + fmt(n, dp)
const pct = (n: number) => `${n.toFixed(1)}%`

// ── Column definitions ────────────────────────────────────────────────────────
type Align = 'left' | 'right' | 'center'
// 'core' columns are always shown. The other 3 are toggleable column groups.
type ColGroup = 'core' | 'billing' | 'profit' | 'employees'
interface Col {
  key: SortKey
  label: string
  width: number
  align: Align
  group: ColGroup
  empId?: string
  sticky?: boolean
  render: (r: AnalysisRow) => React.ReactNode
  cls?: (r: AnalysisRow) => string
}

function buildColumns(employees: EmployeeColumn[], dp: number): Col[] {
  const fixed: Col[] = [
    { key: 'task_number', label: 'Task #', width: 76, align: 'left', group: 'core', sticky: true, render: r => r.task_number ?? '—' },
    { key: 'task_date', label: 'Date', width: 96, align: 'left', group: 'core', render: r => r.task_date },
    { key: 'client_name', label: 'Client', width: 150, align: 'left', group: 'core', render: r => r.client_name },
    { key: 'service_name', label: 'Service', width: 140, align: 'left', group: 'core', render: r => r.service_name },
    { key: 'status', label: 'Status', width: 96, align: 'center', group: 'core', render: r => r.status },
    { key: 'currency', label: 'Cur', width: 56, align: 'center', group: 'billing', render: r => r.currency },
    { key: 'billing', label: 'Billing', width: 100, align: 'right', group: 'billing', render: r => fmt(r.billing, dp) },
    { key: 'billing_inr', label: 'Billing ₹', width: 110, align: 'right', group: 'billing', render: r => inr(r.billing_inr, dp) },
    { key: 'commission_pct', label: 'Comm %', width: 80, align: 'right', group: 'billing', render: r => pct(r.commission_pct) },
    { key: 'commission_pool', label: 'Pool ₹', width: 110, align: 'right', group: 'billing', render: r => inr(r.commission_pool, dp) },
    { key: 'total_earnings', label: 'Emp Earnings ₹', width: 120, align: 'right', group: 'profit', render: r => inr(r.total_earnings, dp) },
    { key: 'company_received', label: 'Received ₹', width: 110, align: 'right', group: 'billing', render: r => inr(r.company_received, dp) },
    {
      key: 'profit', label: 'Exp Profit ₹', width: 110, align: 'right', group: 'profit', render: r => inr(r.profit, dp),
      cls: r => (r.profit < 0 ? 'text-red-400' : 'text-emerald-400'),
    },
    {
      key: 'profit_pct', label: 'Exp Profit %', width: 92, align: 'right', group: 'profit', render: r => pct(r.profit_pct),
      cls: r => (r.profit_pct < 0 ? 'text-red-400' : 'text-emerald-400'),
    },
    {
      key: 'actual_received', label: 'Actual Recv ₹', width: 116, align: 'right', group: 'profit',
      render: r => r.actual_received === null ? <span className="text-muted-foreground/40">—</span> : inr(r.actual_received, dp),
    },
    {
      key: 'fx_gain_loss', label: 'FX +/− ₹', width: 100, align: 'right', group: 'profit',
      render: r => r.fx_gain_loss === null ? <span className="text-muted-foreground/40">—</span> : inr(r.fx_gain_loss, dp),
      cls: r => (r.fx_gain_loss === null ? '' : r.fx_gain_loss < 0 ? 'text-red-400' : r.fx_gain_loss > 0 ? 'text-emerald-400' : ''),
    },
    {
      key: 'actual_profit', label: 'Actual Profit ₹', width: 120, align: 'right', group: 'profit',
      render: r => r.actual_profit === null ? <span className="text-muted-foreground/40">—</span> : inr(r.actual_profit, dp),
      cls: r => (r.actual_profit === null ? '' : r.actual_profit < 0 ? 'text-red-400' : 'text-emerald-400'),
    },
    {
      key: 'actual_profit_pct', label: 'Actual Profit %', width: 100, align: 'right', group: 'profit',
      render: r => r.actual_profit_pct === null ? <span className="text-muted-foreground/40">—</span> : pct(r.actual_profit_pct),
      cls: r => (r.actual_profit_pct === null ? '' : r.actual_profit_pct < 0 ? 'text-red-400' : 'text-emerald-400'),
    },
    { key: 'contributors', label: 'Contrib.', width: 72, align: 'center', group: 'core', render: r => r.contributors },
  ]
  const emp: Col[] = []
  for (const e of employees) {
    emp.push({
      key: `emp:${e.id}:pct`, label: 'Contrib %', width: 78, align: 'right', group: 'employees', empId: e.id,
      render: r => { const c = r.emp[e.id]; return c && c.pct > 0 ? pct(c.pct) : <span className="text-muted-foreground/40">0%</span> },
    })
    emp.push({
      key: `emp:${e.id}:earn`, label: 'Earned ₹', width: 92, align: 'right', group: 'employees', empId: e.id,
      render: r => { const c = r.emp[e.id]; return c && c.earn > 0 ? inr(c.earn, dp) : <span className="text-muted-foreground/40">₹0</span> },
    })
    emp.push({
      key: `emp:${e.id}:share`, label: '% of Bill', width: 80, align: 'right', group: 'employees', empId: e.id,
      render: r => { const s = empShare(r, e.id); return s > 0 ? pct(s) : <span className="text-muted-foreground/40">0%</span> },
    })
  }
  return [...fixed, ...emp]
}

// ── Small inline multi-select (chips dropdown) ────────────────────────────────
function MultiSelect({ label, options, selected, onChange }: {
  label: string
  options: { id: string; name: string }[]
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id])
  return (
    <div className="relative" ref={ref}>
      <label className="block text-[11px] font-medium text-muted-foreground mb-1">{label}</label>
      <button
        type="button" onClick={() => setOpen(o => !o)}
        className="w-full text-left bg-secondary border border-border rounded-lg px-2.5 py-1.5 text-xs hover:border-border/80 flex items-center justify-between gap-1"
      >
        <span className="truncate">{selected.length ? `${selected.length} selected` : `All ${label.toLowerCase()}`}</span>
        <ChevronRight className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-40 mt-1 w-56 max-h-64 overflow-auto bg-card border border-border rounded-lg shadow-xl p-1">
          {selected.length > 0 && (
            <button onClick={() => onChange([])} className="w-full text-left px-2 py-1.5 text-[11px] text-red-400 hover:bg-secondary rounded">Clear selection</button>
          )}
          {options.map(o => (
            <label key={o.id} className="flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-secondary rounded cursor-pointer">
              <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} className="accent-purple-500" />
              <span className="truncate">{o.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// ── URL (de)serialization ─────────────────────────────────────────────────────
const ALL_GROUPS: ColGroup[] = ['billing', 'profit', 'employees']
const GROUP_LABELS: Record<string, string> = { billing: 'Billing', profit: 'Profit & FX', employees: 'Employees' }

function parseFromParams(sp: URLSearchParams): { filters: Filters; sortKey: SortKey; sortDir: SortDir; pageSize: number; decimals: boolean; groups: ColGroup[] } {
  const g = (k: string) => sp.get(k) || ''
  const arr = (k: string) => { const v = sp.get(k); return v ? v.split(',').filter(Boolean) : [] }
  const rawGroups = arr('cols').filter((x): x is ColGroup => (ALL_GROUPS as string[]).includes(x))
  return {
    filters: {
      from: g('from'), to: g('to'), month: g('month'), year: g('year'),
      clientIds: arr('clients'), serviceIds: arr('services'),
      employeeId: g('emp'), statuses: arr('status'),
      billingMin: g('bmin'), billingMax: g('bmax'),
      profitMin: g('pmin'), profitMax: g('pmax'),
      profitPctMin: g('ppmin'), profitPctMax: g('ppmax'),
      earnMin: g('emin'), earnMax: g('emax'),
    },
    sortKey: (g('sort') || 'task_date') as SortKey,
    sortDir: (g('dir') === 'asc' ? 'asc' : 'desc'),
    pageSize: sp.get('size') !== null ? parseInt(sp.get('size')!, 10) : 100,
    decimals: sp.get('dec') === '1',
    // `cols` present ⇒ exactly those groups; absent ⇒ all groups on.
    groups: sp.get('cols') !== null ? rawGroups : [...ALL_GROUPS],
  }
}

export default function ContributionAnalysisClient({ rows, employees, clients, services }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { isUnlocked, dn } = usePrivacy()

  const initial = useMemo(() => parseFromParams(new URLSearchParams(searchParams.toString())), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [filters, setFilters] = useState<Filters>(initial.filters)
  const [sortKey, setSortKey] = useState<SortKey>(initial.sortKey)
  const [sortDir, setSortDir] = useState<SortDir>(initial.sortDir)
  const [pageSize, setPageSize] = useState<number>(initial.pageSize)
  const [page, setPage] = useState(0)
  const [showFilters, setShowFilters] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [decimals, setDecimals] = useState(initial.decimals)
  const [groups, setGroups] = useState<ColGroup[]>(initial.groups)
  const groupSet = useMemo(() => new Set(groups), [groups])

  // Privacy lock: real names only when unlocked, else CQID (shared dn()).
  // When the report is filtered to one employee, narrow the columns to JUST
  // that employee — no point showing everyone else's blank columns.
  const allDisplayEmployees = useMemo(
    () => employees.map(e => ({ ...e, name: dn(e) })),
    [employees, isUnlocked], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const displayEmployees = useMemo(
    () => (filters.employeeId ? allDisplayEmployees.filter(e => e.id === filters.employeeId) : allDisplayEmployees),
    [allDisplayEmployees, filters.employeeId],
  )

  // Full column set (for export) and the visible subset (group toggles applied).
  const allColumns = useMemo(() => buildColumns(displayEmployees, decimals ? 2 : 0), [displayEmployees, decimals])
  const columns = useMemo(
    () => allColumns.filter(c => c.group === 'core' || groupSet.has(c.group)),
    [allColumns, groupSet],
  )
  const totalWidth = useMemo(() => columns.reduce((s, c) => s + c.width, 0), [columns])

  // ── Sync state → URL ────────────────────────────────────────────────────────
  useEffect(() => {
    const p = new URLSearchParams()
    const f = filters
    if (f.from) p.set('from', f.from)
    if (f.to) p.set('to', f.to)
    if (f.month) p.set('month', f.month)
    if (f.year) p.set('year', f.year)
    if (f.clientIds.length) p.set('clients', f.clientIds.join(','))
    if (f.serviceIds.length) p.set('services', f.serviceIds.join(','))
    if (f.employeeId) p.set('emp', f.employeeId)
    if (f.statuses.length) p.set('status', f.statuses.join(','))
    if (f.billingMin) p.set('bmin', f.billingMin)
    if (f.billingMax) p.set('bmax', f.billingMax)
    if (f.profitMin) p.set('pmin', f.profitMin)
    if (f.profitMax) p.set('pmax', f.profitMax)
    if (f.profitPctMin) p.set('ppmin', f.profitPctMin)
    if (f.profitPctMax) p.set('ppmax', f.profitPctMax)
    if (f.earnMin) p.set('emin', f.earnMin)
    if (f.earnMax) p.set('emax', f.earnMax)
    if (sortKey !== 'task_date') p.set('sort', sortKey)
    if (sortDir !== 'desc') p.set('dir', sortDir)
    if (pageSize !== 100) p.set('size', String(pageSize))
    if (decimals) p.set('dec', '1')
    // Only serialise `cols` when not all groups are on (keeps URLs clean).
    if (groups.length !== ALL_GROUPS.length) p.set('cols', [...groups].sort().join(','))
    const qs = p.toString()
    if (qs !== searchParams.toString()) router.replace(`${pathname}${qs ? '?' + qs : ''}`, { scroll: false })
  }, [filters, sortKey, sortDir, pageSize, decimals, groups, pathname, router, searchParams])

  // ── Pipeline: filter → sort ───────────────────────────────────────────────────
  const filtered = useMemo(() => applyFilters(rows, filters), [rows, filters])
  const sorted = useMemo(() => sortRows(filtered, sortKey, sortDir), [filtered, sortKey, sortDir])
  const summary = useMemo(() => computeSummary(filtered), [filtered])

  // Reset to first page whenever the result set changes shape.
  useEffect(() => { setPage(0) }, [filters, sortKey, sortDir, pageSize])

  const size = pageSize === 0 ? sorted.length : pageSize
  const pageCount = Math.max(1, Math.ceil(sorted.length / Math.max(1, size)))
  const safePage = Math.min(page, pageCount - 1)
  const pageRows = useMemo(
    () => (pageSize === 0 ? sorted : sorted.slice(safePage * size, safePage * size + size)),
    [sorted, pageSize, safePage, size],
  )

  // ── Virtualized body ──────────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(560)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    setViewH(el.clientHeight)
    return () => ro.disconnect()
  }, [])
  const overscan = 8
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - overscan)
  const endIdx = Math.min(pageRows.length, Math.ceil((scrollTop + viewH) / ROW_H) + overscan)
  const visible = pageRows.slice(startIdx, endIdx)

  const toggleSort = useCallback((key: SortKey) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('desc') }
  }, [sortKey])

  const activeFilterCount = useMemo(() => {
    const f = filters
    let n = 0
    if (f.from || f.to || f.month || f.year) n++
    if (f.clientIds.length) n++
    if (f.serviceIds.length) n++
    if (f.employeeId) n++
    if (f.statuses.length) n++
    if (f.billingMin || f.billingMax) n++
    if (f.profitMin || f.profitMax) n++
    if (f.profitPctMin || f.profitPctMax) n++
    if (f.earnMin || f.earnMax) n++
    return n
  }, [filters])

  // ── Exports (operate on the filtered+sorted set — matches the screen) ─────────
  const exportCSV = useCallback(() => {
    const csv = matrixToCSV(toMatrix(sorted, displayEmployees))
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `contribution-analysis-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [sorted, employees])

  const exportXLSX = useCallback(async () => {
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const ws = XLSX.utils.aoa_to_sheet(toMatrix(sorted, displayEmployees))
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Contribution Analysis')
      XLSX.writeFile(wb, `contribution-analysis-${new Date().toISOString().slice(0, 10)}.xlsx`)
    } finally {
      setExporting(false)
    }
  }, [sorted, employees])

  const printView = useCallback(() => {
    const matrix = toMatrix(sorted, displayEmployees)
    const [head, ...body] = matrix
    const w = window.open('', '_blank')
    if (!w) return
    const th = head.map(h => `<th>${h}</th>`).join('')
    const trs = body.map(r => `<tr>${r.map((c, i) => `<td class="${i >= 6 ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('')
    w.document.write(`<html><head><title>Contribution Analysis</title><style>
      body{font-family:system-ui,sans-serif;padding:16px;color:#111}
      h1{font-size:16px;margin:0 0 4px} p{color:#666;font-size:11px;margin:0 0 12px}
      table{border-collapse:collapse;width:100%;font-size:10px}
      th,td{border:1px solid #ddd;padding:3px 6px;text-align:left;white-space:nowrap}
      th{background:#f3f4f6} td.num{text-align:right} tr:nth-child(even){background:#fafafa}
    </style></head><body>
      <h1>Contribution Analysis Report</h1>
      <p>${sorted.length} tasks · generated ${new Date().toLocaleString('en-IN')}</p>
      <table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>
    </body></html>`)
    w.document.close()
    w.focus()
    setTimeout(() => w.print(), 250)
  }, [sorted, employees])

  const gridTemplate = columns.map(c => `${c.width}px`).join(' ')
  // Fixed (non-employee) columns come first; each visible employee owns 3.
  const fixedCount = columns.filter(c => c.group !== 'employees').length
  // Employee groups currently visible, in display order (for the grouped header).
  const visibleEmpGroups = useMemo(
    () => (groupSet.has('employees') ? displayEmployees : []),
    [groupSet, displayEmployees],
  )

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      <Header title="Contribution Analysis" subtitle="Per-task profitability, earnings & employee contribution breakdown" />

      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4">
        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-5 gap-3">
          {[
            { label: 'Total Tasks', value: fmt(summary.totalTasks, 0) },
            { label: 'Total Billing', value: inr(summary.totalBilling, decimals ? 2 : 0) },
            { label: 'Commission Pool', value: inr(summary.totalPool, decimals ? 2 : 0) },
            { label: 'Employee Earnings', value: inr(summary.totalEarnings, decimals ? 2 : 0) },
            { label: 'Avg Contribution %', value: pct(summary.avgContributionPct) },
            { label: 'Expected Profit', value: inr(summary.totalProfit, decimals ? 2 : 0), accent: summary.totalProfit < 0 ? 'text-red-400' : 'text-emerald-400' },
            { label: 'Avg Expected Profit %', value: pct(summary.avgProfitPct), accent: summary.avgProfitPct < 0 ? 'text-red-400' : 'text-emerald-400' },
            { label: 'Actual Received', value: inr(summary.totalActualReceived, decimals ? 2 : 0), sub: `${fmt(summary.actualTasks, 0)} paid tasks` },
            { label: 'FX Gain / Loss', value: inr(summary.totalFxGainLoss, decimals ? 2 : 0), accent: summary.totalFxGainLoss < 0 ? 'text-red-400' : summary.totalFxGainLoss > 0 ? 'text-emerald-400' : '' },
            { label: 'Actual Profit', value: inr(summary.totalActualProfit, decimals ? 2 : 0), accent: summary.totalActualProfit < 0 ? 'text-red-400' : 'text-emerald-400' },
          ].map(c => (
            <div key={c.label} className="bg-card border border-border rounded-xl p-3">
              <div className="text-[11px] text-muted-foreground mb-1 truncate">{c.label}</div>
              <div className={`text-lg font-semibold tabular-nums ${(c as any).accent || ''}`}>{c.value}</div>
              {(c as any).sub && <div className="text-[10px] text-muted-foreground/60 mt-0.5">{(c as any).sub}</div>}
            </div>
          ))}
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setShowFilters(s => !s)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
              showFilters || activeFilterCount ? 'gradient-bg text-white border-transparent' : 'bg-card border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            <SlidersHorizontal className="w-4 h-4" />
            Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
          </button>
          {activeFilterCount > 0 && (
            <button onClick={() => setFilters(EMPTY_FILTERS)} className="flex items-center gap-1 px-2.5 py-2 rounded-lg text-sm text-red-400 hover:bg-secondary">
              <X className="w-3.5 h-3.5" /> Clear
            </button>
          )}
          <div className="text-sm text-muted-foreground ml-1">
            <span className="font-semibold text-foreground">{fmt(sorted.length, 0)}</span> of {fmt(rows.length, 0)} tasks
          </div>

          {/* Column group toggles — show/hide whole blocks of columns */}
          <div className="flex items-center gap-1 ml-1 pl-2 border-l border-border">
            <span className="text-[11px] text-muted-foreground mr-0.5">Columns:</span>
            {ALL_GROUPS.map(gp => {
              const on = groupSet.has(gp)
              return (
                <button
                  key={gp}
                  onClick={() => setGroups(prev => prev.includes(gp) ? prev.filter(x => x !== gp) : [...prev, gp])}
                  className={`px-2 py-1 rounded-md text-[11px] font-medium border transition-colors ${
                    on ? 'gradient-bg text-white border-transparent' : 'bg-card border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {GROUP_LABELS[gp]}
                </button>
              )
            })}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setDecimals(d => !d)}
              title={decimals ? 'Showing 2 decimals — click for whole numbers' : 'Showing whole numbers — click for 2 decimals'}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                decimals ? 'gradient-bg text-white border-transparent' : 'bg-card border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="tabular-nums text-xs">.00</span> Decimals
            </button>
            <button onClick={exportCSV} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-card border border-border text-muted-foreground hover:text-foreground" title="Export CSV">
              <Download className="w-4 h-4" /> CSV
            </button>
            <button onClick={exportXLSX} disabled={exporting} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-card border border-border text-muted-foreground hover:text-foreground disabled:opacity-50" title="Export Excel">
              <FileSpreadsheet className="w-4 h-4" /> {exporting ? '…' : 'Excel'}
            </button>
            <button onClick={printView} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-card border border-border text-muted-foreground hover:text-foreground" title="Print">
              <Printer className="w-4 h-4" /> Print
            </button>
          </div>
        </div>

        {/* Filter panel */}
        {showFilters && (
          <div className="bg-card border border-border rounded-xl p-4 space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-muted-foreground mb-1">From date</label>
                <input type="date" value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-2.5 py-1.5 text-xs" />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-muted-foreground mb-1">To date</label>
                <input type="date" value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-2.5 py-1.5 text-xs" />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-muted-foreground mb-1">Month</label>
                <select value={filters.month} onChange={e => setFilters(f => ({ ...f, month: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-2.5 py-1.5 text-xs">
                  <option value="">Any</option>
                  {MONTHS.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-muted-foreground mb-1">Year</label>
                <input type="number" placeholder="Any" value={filters.year} onChange={e => setFilters(f => ({ ...f, year: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-2.5 py-1.5 text-xs" />
              </div>
              <MultiSelect label="Clients" options={clients} selected={filters.clientIds} onChange={ids => setFilters(f => ({ ...f, clientIds: ids }))} />
              <MultiSelect label="Services" options={services} selected={filters.serviceIds} onChange={ids => setFilters(f => ({ ...f, serviceIds: ids }))} />
              <div>
                <label className="block text-[11px] font-medium text-muted-foreground mb-1">Has contributor</label>
                <select value={filters.employeeId} onChange={e => setFilters(f => ({ ...f, employeeId: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-2.5 py-1.5 text-xs">
                  <option value="">Any employee</option>
                  {allDisplayEmployees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </div>
              <MultiSelect label="Status" options={STATUSES.map(s => ({ id: s, name: s }))} selected={filters.statuses} onChange={ids => setFilters(f => ({ ...f, statuses: ids }))} />
            </div>

            {/* Numeric ranges */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-1 border-t border-border">
              {([
                ['Billing ₹', 'billingMin', 'billingMax'],
                ['Profit ₹', 'profitMin', 'profitMax'],
                ['Profit %', 'profitPctMin', 'profitPctMax'],
                ['Emp Earnings ₹', 'earnMin', 'earnMax'],
              ] as const).map(([label, minK, maxK]) => (
                <div key={label}>
                  <label className="block text-[11px] font-medium text-muted-foreground mb-1 mt-2">{label} range</label>
                  <div className="flex items-center gap-1">
                    <input type="number" placeholder="min" value={filters[minK]} onChange={e => setFilters(f => ({ ...f, [minK]: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs" />
                    <span className="text-muted-foreground text-xs">–</span>
                    <input type="number" placeholder="max" value={filters[maxK]} onChange={e => setFilters(f => ({ ...f, [maxK]: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-2 py-1.5 text-xs" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Spreadsheet table */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div ref={scrollRef} onScroll={e => setScrollTop((e.target as HTMLDivElement).scrollTop)} className="overflow-auto" style={{ maxHeight: '62vh' }}>
            <div style={{ width: totalWidth, minWidth: '100%' }}>
              {/* Two-tier header: fixed columns span both rows; each employee
                  is one group header over 3 sortable sub-columns. */}
              <div className="sticky top-0 z-20 grid bg-secondary border-b border-border" style={{ gridTemplateColumns: gridTemplate, gridTemplateRows: 'auto auto' }}>
                {/* Fixed columns — span both header rows */}
                {columns.slice(0, fixedCount).map((c, ci) => {
                  const active = sortKey === c.key
                  return (
                    <button
                      key={c.key} onClick={() => toggleSort(c.key)}
                      style={{ gridColumn: `${ci + 1} / ${ci + 2}`, gridRow: '1 / 3' }}
                      className={`flex items-center gap-0.5 px-2 py-2 text-[11px] font-semibold whitespace-nowrap hover:bg-secondary/70 ${
                        c.align === 'right' ? 'justify-end' : c.align === 'center' ? 'justify-center' : 'justify-start'
                      } ${active ? 'text-purple-400' : 'text-muted-foreground'} ${c.sticky ? 'sticky left-0 z-30 bg-secondary' : ''}`}
                    >
                      <span className="truncate">{c.label}</span>
                      {active && (sortDir === 'asc' ? <ArrowUp className="w-3 h-3 shrink-0" /> : <ArrowDown className="w-3 h-3 shrink-0" />)}
                    </button>
                  )
                })}
                {/* Employee groups — name on top row, 3 sub-headers below */}
                {visibleEmpGroups.map((e, k) => {
                  const base = fixedCount + 3 * k + 1   // 1-based grid line of this group
                  const subCols = columns.slice(fixedCount + 3 * k, fixedCount + 3 * k + 3)
                  return (
                    <Fragment key={e.id}>
                      <div
                        style={{ gridColumn: `${base} / ${base + 3}`, gridRow: '1 / 2' }}
                        className="flex items-center justify-center px-2 py-1 text-[11px] font-semibold text-sky-400 truncate border-l border-border"
                        title={e.name}
                      >
                        <span className="truncate">{e.name}</span>
                      </div>
                      {subCols.map((c, j) => {
                        const active = sortKey === c.key
                        return (
                          <button
                            key={c.key} onClick={() => toggleSort(c.key)}
                            style={{ gridColumn: `${base + j} / ${base + j + 1}`, gridRow: '2 / 3' }}
                            className={`flex items-center justify-end gap-0.5 px-2 py-1.5 text-[10px] font-medium whitespace-nowrap hover:bg-secondary/70 ${j === 0 ? 'border-l border-border' : ''} ${active ? 'text-purple-400' : 'text-muted-foreground'}`}
                          >
                            <span className="truncate">{c.label}</span>
                            {active && (sortDir === 'asc' ? <ArrowUp className="w-3 h-3 shrink-0" /> : <ArrowDown className="w-3 h-3 shrink-0" />)}
                          </button>
                        )
                      })}
                    </Fragment>
                  )
                })}
              </div>

              {/* Virtualized body */}
              {pageRows.length === 0 ? (
                <div className="p-10 text-center text-sm text-muted-foreground">No tasks match the current filters.</div>
              ) : (
                <div style={{ height: pageRows.length * ROW_H, position: 'relative' }}>
                  {visible.map((r, i) => {
                    const idx = startIdx + i
                    return (
                      <div
                        key={r.task_id}
                        className={`grid absolute left-0 right-0 border-b border-border/50 hover:bg-secondary/40 ${idx % 2 ? 'bg-secondary/10' : ''}`}
                        style={{ top: idx * ROW_H, height: ROW_H, gridTemplateColumns: gridTemplate }}
                      >
                        {columns.map((c, ci) => {
                          // Left border at the start of each employee's 3-col group.
                          const groupStart = ci >= fixedCount && (ci - fixedCount) % 3 === 0
                          return (
                            <div
                              key={c.key}
                              className={`px-2 flex items-center text-xs whitespace-nowrap overflow-hidden tabular-nums ${
                                c.align === 'right' ? 'justify-end' : c.align === 'center' ? 'justify-center' : 'justify-start'
                              } ${c.sticky ? 'sticky left-0 z-10 bg-card' : ''} ${groupStart ? 'border-l border-border/60' : ''} ${c.cls ? c.cls(r) : ''}`}
                            >
                              <span className="truncate">{c.render(r)}</span>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Pagination footer */}
          <div className="flex items-center justify-between gap-3 px-3 py-2 border-t border-border text-xs">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Rows per page</span>
              <select value={pageSize} onChange={e => setPageSize(parseInt(e.target.value, 10))} className="bg-secondary border border-border rounded-lg px-2 py-1">
                {PAGE_SIZES.map(s => <option key={s} value={s}>{s === 0 ? 'All' : s}</option>)}
              </select>
            </div>
            {pageSize !== 0 && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Page {safePage + 1} of {pageCount}</span>
                <button disabled={safePage === 0} onClick={() => setPage(p => Math.max(0, p - 1))} className="p-1 rounded border border-border disabled:opacity-40 hover:bg-secondary"><ChevronLeft className="w-4 h-4" /></button>
                <button disabled={safePage >= pageCount - 1} onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} className="p-1 rounded border border-border disabled:opacity-40 hover:bg-secondary"><ChevronRight className="w-4 h-4" /></button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
