'use client'

import { useState, useMemo, useEffect, useRef, useCallback, Fragment } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import Header from '@/components/layout/header'
import { usePrivacy } from '@/contexts/privacy-context'
import {
  applyFilters, sortRows, computeSummary, toMatrix, toMatrixGrouped, matrixToCSV, empShare,
  groupRows, GROUP_OPTIONS,
  EMPTY_FILTERS, type Filters, type AnalysisRow, type EmployeeColumn,
  type SortKey, type SortDir, type GroupKey, type RowGroup, type Summary,
} from '@/lib/reports/contribution-analysis'
import {
  Download, Printer, FileSpreadsheet, SlidersHorizontal, X, ArrowUp, ArrowDown,
  ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Layers, Pin, GripVertical,
  Save, RotateCcw, Building2, Check,
} from 'lucide-react'
import { savePersonalReportLayout, saveSystemReportLayout } from './actions'

// Persisted layout shape (stored as JSONB). All fields optional so older/newer
// saved layouts stay forward-compatible. The index signature both allows future
// layout settings without a type change and makes it a valid JSON record.
interface LayoutConfig {
  version?: number
  colOrder?: string[]
  groups?: ColGroup[]
  frozenCols?: string[]
  sortKey?: SortKey
  sortDir?: SortDir
  [key: string]: unknown
}

interface Props {
  rows: AnalysisRow[]
  employees: EmployeeColumn[]
  clients: { id: string; name: string }[]
  services: { id: string; name: string }[]
  isAdmin: boolean
  personalLayout: LayoutConfig | null
  systemLayout: LayoutConfig | null
}

const REPORT_NAME = 'contribution_analysis'

const STATUSES = ['pending', 'in_progress', 'done', 'delivered', 'invoiced', 'paid', 'cancelled']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ROW_H = 38
const GROUP_H = 40   // group header banner height
const SUB_H = 34     // group subtotal row height
const PAGE_SIZES = [50, 100, 250, 1000, 0] // 0 = All

// Columns frozen on initial load (before the user changes anything).
// Keys match the `key` field in buildColumns (e.g. 'task_number', 'client_name').
const DEFAULT_FROZEN_COLS: string[] = ['task_number', 'title', 'client_name']
const LS_FROZEN_KEY = 'ca-frozen-cols'

// Default display order for non-employee columns.
// Change this array to set the factory-default column sequence.
const DEFAULT_COL_ORDER: string[] = [
  'title', 'task_date', 'client_name', 'task_number', 'service_name', 'status',
  'currency', 'billing', 'billing_inr', 'commission_pct', 'commission_pool',
  'total_earnings', 'company_received', 'profit', 'profit_pct',
  'actual_received', 'fx_gain_loss', 'actual_profit', 'actual_profit_pct', 'contributors',
]
const LS_COL_ORDER_KEY = 'ca-col-order'

// Largest index i with offsets[i] <= y (binary search; offsets is monotonic).
function idxAtOffset(offsets: number[], y: number): number {
  let lo = 0, hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

// Color class for the colored subtotal metrics (profit / actual profit / FX).
function subColor(key: string, s: Summary): string {
  if (key === 'profit') return s.totalProfit < 0 ? 'text-red-400' : 'text-emerald-400'
  if (key === 'actual_profit') return s.actualTasks ? (s.totalActualProfit < 0 ? 'text-red-400' : 'text-emerald-400') : ''
  if (key === 'fx_gain_loss') return s.actualTasks ? (s.totalFxGainLoss < 0 ? 'text-red-400' : s.totalFxGainLoss > 0 ? 'text-emerald-400' : '') : ''
  return ''
}

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

// A flat, virtualizable list item. Group headers / subtotals interleave with
// data rows; each carries its own pixel height so the body can be variable-height.
type DisplayItem =
  | { kind: 'data'; h: number; row: AnalysisRow; z: number }
  | { kind: 'group'; h: number; group: RowGroup }
  | { kind: 'subtotal'; h: number; group: RowGroup }

function buildColumns(employees: EmployeeColumn[], dp: number): Col[] {
  const fixed: Col[] = [
    { key: 'task_number', label: 'Task #', width: 76, align: 'left', group: 'core', sticky: true, render: r => r.task_number ?? '—' },
    { key: 'title', label: 'Title', width: 200, align: 'left', group: 'core', render: r => r.title },
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

function parseFromParams(sp: URLSearchParams): { filters: Filters; sortKey: SortKey; sortDir: SortDir; pageSize: number; decimals: boolean; groups: ColGroup[]; groupKey: GroupKey } {
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
    groupKey: (['client', 'service', 'status', 'month', 'year'] as string[]).includes(g('grp')) ? (g('grp') as GroupKey) : 'none',
  }
}

export default function ContributionAnalysisClient({ rows, employees, clients, services, isAdmin, personalLayout, systemLayout }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { isUnlocked, dn } = usePrivacy()

  // Saved layouts held in state so "Reset" uses the freshest value after a Save
  // within the same session (no page reload needed).
  const [savedPersonal, setSavedPersonal] = useState<LayoutConfig | null>(personalLayout)
  const [savedSystem, setSavedSystem] = useState<LayoutConfig | null>(systemLayout)
  // Initial-load priority: personal → system → hardcoded (URL params still win
  // for the shareable fields: groups + sort).
  const dbLayout = personalLayout ?? systemLayout ?? null
  const sp0 = useMemo(() => new URLSearchParams(searchParams.toString()), []) // eslint-disable-line react-hooks/exhaustive-deps
  const hasUrlCols = sp0.get('cols') !== null
  const hasUrlSort = sp0.get('sort') !== null

  const initial = useMemo(() => parseFromParams(sp0), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [filters, setFilters] = useState<Filters>(initial.filters)
  const [sortKey, setSortKey] = useState<SortKey>(hasUrlSort ? initial.sortKey : (dbLayout?.sortKey ?? initial.sortKey))
  const [sortDir, setSortDir] = useState<SortDir>(hasUrlSort ? initial.sortDir : (dbLayout?.sortDir ?? initial.sortDir))
  const [pageSize, setPageSize] = useState<number>(initial.pageSize)
  const [page, setPage] = useState(0)
  const [showFilters, setShowFilters] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [decimals, setDecimals] = useState(initial.decimals)
  const [groups, setGroups] = useState<ColGroup[]>(hasUrlCols ? initial.groups : ((dbLayout?.groups as ColGroup[] | undefined) ?? initial.groups))
  const groupSet = useMemo(() => new Set(groups), [groups])
  const [groupKey, setGroupKey] = useState<GroupKey>(initial.groupKey)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  // ── Freeze columns ──────────────────────────────────────────────────────────
  // Priority: localStorage working copy → saved layout → compiled-in defaults.
  const [frozenCols, setFrozenCols] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(LS_FROZEN_KEY)
      if (saved !== null) return new Set<string>(JSON.parse(saved))
    } catch {}
    return new Set(dbLayout?.frozenCols ?? DEFAULT_FROZEN_COLS)
  })
  const [showFreezePanel, setShowFreezePanel] = useState(false)
  const freezePanelRef = useRef<HTMLDivElement>(null)

  // Persist frozen set whenever it changes.
  useEffect(() => {
    try { localStorage.setItem(LS_FROZEN_KEY, JSON.stringify([...frozenCols])) } catch {}
  }, [frozenCols])

  // Close freeze panel on outside click.
  useEffect(() => {
    if (!showFreezePanel) return
    const h = (e: MouseEvent) => {
      if (freezePanelRef.current && !freezePanelRef.current.contains(e.target as Node))
        setShowFreezePanel(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [showFreezePanel])

  const toggleFreeze = useCallback((key: string) => {
    setFrozenCols(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }, [])

  // ── Column order ─────────────────────────────────────────────────────────────
  const [colOrder, setColOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(LS_COL_ORDER_KEY)
      if (saved) return JSON.parse(saved) as string[]
    } catch {}
    return [...(dbLayout?.colOrder ?? DEFAULT_COL_ORDER)]
  })
  const [showColOrderPanel, setShowColOrderPanel] = useState(false)
  const colOrderPanelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try { localStorage.setItem(LS_COL_ORDER_KEY, JSON.stringify(colOrder)) } catch {}
  }, [colOrder])

  useEffect(() => {
    if (!showColOrderPanel) return
    const h = (e: MouseEvent) => {
      if (colOrderPanelRef.current && !colOrderPanelRef.current.contains(e.target as Node))
        setShowColOrderPanel(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [showColOrderPanel])

  const moveCol = useCallback((key: string, dir: -1 | 1) => {
    setColOrder(prev => {
      const idx = prev.indexOf(key)
      if (idx < 0) return prev
      const next = idx + dir
      if (next < 0 || next >= prev.length) return prev
      const arr = [...prev]
      ;[arr[idx], arr[next]] = [arr[next], arr[idx]]
      return arr
    })
  }, [])

  // ── Saved layouts (personal / system default) ────────────────────────────────
  const [savingLayout, setSavingLayout] = useState<null | 'personal' | 'system'>(null)
  const [layoutMsg, setLayoutMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const layoutMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashLayoutMsg = useCallback((kind: 'ok' | 'err', text: string) => {
    setLayoutMsg({ kind, text })
    if (layoutMsgTimer.current) clearTimeout(layoutMsgTimer.current)
    layoutMsgTimer.current = setTimeout(() => setLayoutMsg(null), 2600)
  }, [])

  // Snapshot the current layout-affecting state into a persistable object.
  const buildCurrentLayout = useCallback((): LayoutConfig => ({
    version: 1,
    colOrder,
    groups,
    frozenCols: [...frozenCols],
    sortKey,
    sortDir,
  }), [colOrder, groups, frozenCols, sortKey, sortDir])

  // Apply a saved layout (or the hardcoded fallback when null) to live state.
  // The existing localStorage / URL sync effects pick up the changes, so the
  // working copy stays consistent after a reset.
  const applyLayout = useCallback((layout: LayoutConfig | null) => {
    if (layout?.colOrder) setColOrder([...layout.colOrder]); else setColOrder([...DEFAULT_COL_ORDER])
    if (layout?.frozenCols) setFrozenCols(new Set(layout.frozenCols)); else setFrozenCols(new Set(DEFAULT_FROZEN_COLS))
    if (layout?.groups) setGroups([...(layout.groups as ColGroup[])]); else setGroups([...ALL_GROUPS])
    if (layout?.sortKey) setSortKey(layout.sortKey)
    if (layout?.sortDir) setSortDir(layout.sortDir)
  }, [])

  const handleSavePersonal = useCallback(async () => {
    setSavingLayout('personal')
    const layout = buildCurrentLayout()
    const res = await savePersonalReportLayout(REPORT_NAME, layout)
    setSavingLayout(null)
    if (res.ok) { setSavedPersonal(layout); flashLayoutMsg('ok', 'Saved as your default') }
    else flashLayoutMsg('err', res.error ?? 'Save failed')
  }, [buildCurrentLayout, flashLayoutMsg])

  const handleSaveSystem = useCallback(async () => {
    setSavingLayout('system')
    const layout = buildCurrentLayout()
    const res = await saveSystemReportLayout(REPORT_NAME, layout)
    setSavingLayout(null)
    if (res.ok) { setSavedSystem(layout); flashLayoutMsg('ok', 'Saved as system default') }
    else flashLayoutMsg('err', res.error ?? 'Save failed')
  }, [buildCurrentLayout, flashLayoutMsg])

  const handleResetMine = useCallback(() => {
    const target = savedPersonal ?? savedSystem ?? null
    applyLayout(target)
    flashLayoutMsg('ok', savedPersonal ? 'Restored your default' : savedSystem ? 'No personal layout — using system' : 'Restored built-in default')
  }, [savedPersonal, savedSystem, applyLayout, flashLayoutMsg])

  const handleResetSystem = useCallback(() => {
    applyLayout(savedSystem ?? null)
    flashLayoutMsg('ok', savedSystem ? 'Restored system default' : 'No system default — using built-in')
  }, [savedSystem, applyLayout, flashLayoutMsg])

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
  // Non-employee columns are sorted according to the user's colOrder preference.
  const allColumns = useMemo(() => {
    const cols = buildColumns(displayEmployees, decimals ? 2 : 0)
    const empCols = cols.filter(c => c.group === 'employees')
    const fixedCols = cols.filter(c => c.group !== 'employees')
    // Apply saved order; any new column keys not yet in the saved order are appended.
    const ordered = [
      ...colOrder.map(k => fixedCols.find(c => c.key === k)).filter((c): c is Col => !!c),
      ...fixedCols.filter(c => !colOrder.includes(c.key)),
    ]
    return [...ordered, ...empCols]
  }, [displayEmployees, decimals, colOrder])
  const columns = useMemo(
    () => allColumns.filter(c => c.group === 'core' || groupSet.has(c.group)),
    [allColumns, groupSet],
  )
  const totalWidth = useMemo(() => columns.reduce((s, c) => s + c.width, 0), [columns])

  // ── Freeze column helpers ─────────────────────────────────────────────────
  // Cumulative left-offset for each frozen column key (for sticky positioning).
  const frozenLeftMap = useMemo(() => {
    const map = new Map<string, number>()
    let left = 0
    for (const col of columns) {
      if (frozenCols.has(col.key)) {
        map.set(col.key, left)
        left += col.width
      }
    }
    return map
  }, [columns, frozenCols])

  // Key of the rightmost frozen column — gets a separator border.
  const lastFrozenKey = useMemo(() => {
    let last: string | null = null
    for (const col of columns) if (frozenCols.has(col.key)) last = col.key
    return last
  }, [columns, frozenCols])

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
    if (groupKey !== 'none') p.set('grp', groupKey)
    const qs = p.toString()
    if (qs !== searchParams.toString()) router.replace(`${pathname}${qs ? '?' + qs : ''}`, { scroll: false })
  }, [filters, sortKey, sortDir, pageSize, decimals, groups, groupKey, pathname, router, searchParams])

  // ── Pipeline: filter → sort ───────────────────────────────────────────────────
  const filtered = useMemo(() => applyFilters(rows, filters), [rows, filters])
  const sorted = useMemo(() => sortRows(filtered, sortKey, sortDir), [filtered, sortKey, sortDir])
  const summary = useMemo(() => computeSummary(filtered), [filtered])
  // Per-employee earnings totals over the whole filtered set (for the totals row).
  const empEarnTotals = useMemo(() => {
    const out: Record<string, number> = {}
    for (const r of filtered) {
      for (const id in r.emp) out[id] = (out[id] || 0) + r.emp[id].earn
    }
    return out
  }, [filtered])
  // Grouped view: partition the full sorted set (pagination is bypassed when grouping).
  const grouped = useMemo(
    () => (groupKey === 'none' ? [] : groupRows(sorted, groupKey)),
    [sorted, groupKey],
  )

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
  // Flatten the (paged or grouped) result set into a variable-height list.
  const items = useMemo<DisplayItem[]>(() => {
    if (groupKey === 'none') return pageRows.map((row, z) => ({ kind: 'data', h: ROW_H, row, z }))
    const out: DisplayItem[] = []
    let z = 0
    for (const g of grouped) {
      out.push({ kind: 'group', h: GROUP_H, group: g })
      if (!collapsed.has(g.key)) for (const row of g.rows) out.push({ kind: 'data', h: ROW_H, row, z: z++ })
      out.push({ kind: 'subtotal', h: SUB_H, group: g })
    }
    return out
  }, [groupKey, pageRows, grouped, collapsed])

  // Prefix-sum of item heights → O(log n) viewport slicing for variable heights.
  const offsets = useMemo(() => {
    const o = new Array<number>(items.length + 1)
    o[0] = 0
    for (let i = 0; i < items.length; i++) o[i + 1] = o[i] + items[i].h
    return o
  }, [items])
  const totalH = items.length ? offsets[items.length] : 0
  const overscanPx = 240
  const startIdx = idxAtOffset(offsets, Math.max(0, scrollTop - overscanPx))
  const endIdx = Math.min(items.length, idxAtOffset(offsets, scrollTop + viewH + overscanPx) + 1)
  const visible = items.slice(startIdx, endIdx)

  const toggleSort = useCallback((key: SortKey) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('desc') }
  }, [sortKey])

  const toggleCollapse = useCallback((k: string) => {
    setCollapsed(prev => {
      const n = new Set(prev)
      if (n.has(k)) n.delete(k); else n.add(k)
      return n
    })
  }, [])
  const collapseAll = useCallback(() => setCollapsed(new Set(grouped.map(g => g.key))), [grouped])
  const expandAll = useCallback(() => setCollapsed(new Set()), [])

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
  // Export matches the screen: grouped (with subtotal rows) when grouping is on.
  const buildExportMatrix = useCallback(
    () => (groupKey === 'none' ? toMatrix(sorted, displayEmployees) : toMatrixGrouped(grouped, displayEmployees)),
    [groupKey, sorted, grouped, displayEmployees],
  )

  const exportCSV = useCallback(() => {
    const csv = matrixToCSV(buildExportMatrix())
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `contribution-analysis-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [buildExportMatrix])

  const exportXLSX = useCallback(async () => {
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const ws = XLSX.utils.aoa_to_sheet(buildExportMatrix())
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Contribution Analysis')
      XLSX.writeFile(wb, `contribution-analysis-${new Date().toISOString().slice(0, 10)}.xlsx`)
    } finally {
      setExporting(false)
    }
  }, [buildExportMatrix])

  const printView = useCallback(() => {
    const matrix = buildExportMatrix()
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
  }, [buildExportMatrix, sorted])

  const gridTemplate = columns.map(c => `${c.width}px`).join(' ')
  // Fixed (non-employee) columns come first; each visible employee owns 3.
  const fixedCount = columns.filter(c => c.group !== 'employees').length
  // Employee groups currently visible, in display order (for the grouped header).
  const visibleEmpGroups = useMemo(
    () => (groupSet.has('employees') ? displayEmployees : []),
    [groupSet, displayEmployees],
  )

  // Value shown in a subtotal cell under each visible column.
  const dp = decimals ? 2 : 0
  const subtotalCell = (c: Col, g: RowGroup): React.ReactNode => {
    const s = g.summary
    switch (c.key) {
      case 'task_number': return 'Σ'
      case 'task_date': return `${fmt(s.totalTasks, 0)} tasks`
      case 'billing_inr': return inr(s.totalBilling, dp)
      case 'company_received': return inr(s.totalBilling, dp)
      case 'commission_pool': return inr(s.totalPool, dp)
      case 'total_earnings': return inr(s.totalEarnings, dp)
      case 'profit': return inr(s.totalProfit, dp)
      case 'profit_pct': return pct(s.avgProfitPct)
      case 'actual_received': return s.actualTasks ? inr(s.totalActualReceived, dp) : '—'
      case 'fx_gain_loss': return s.actualTasks ? inr(s.totalFxGainLoss, dp) : '—'
      case 'actual_profit': return s.actualTasks ? inr(s.totalActualProfit, dp) : '—'
      case 'actual_profit_pct':
        return s.actualTasks && s.totalActualReceived ? pct(s.totalActualProfit / s.totalActualReceived * 100) : '—'
      default:
        if (c.empId && c.key.endsWith(':earn')) return inr(g.empEarn[c.empId] ?? 0, dp)
        return ''
    }
  }

  // Grand total for a column over the entire filtered set (totals row under the header).
  const grandTotalCell = (c: Col): React.ReactNode => {
    const s = summary
    switch (c.key) {
      case 'task_number': return 'Σ'
      case 'title': return 'TOTAL'
      case 'task_date': return `${fmt(s.totalTasks, 0)} tasks`
      case 'billing_inr': return inr(s.totalBilling, dp)
      case 'company_received': return inr(s.totalBilling, dp)
      case 'commission_pool': return inr(s.totalPool, dp)
      case 'total_earnings': return inr(s.totalEarnings, dp)
      case 'profit': return inr(s.totalProfit, dp)
      case 'profit_pct': return pct(s.avgProfitPct)
      case 'actual_received': return s.actualTasks ? inr(s.totalActualReceived, dp) : '—'
      case 'fx_gain_loss': return s.actualTasks ? inr(s.totalFxGainLoss, dp) : '—'
      case 'actual_profit': return s.actualTasks ? inr(s.totalActualProfit, dp) : '—'
      case 'actual_profit_pct':
        return s.actualTasks && s.totalActualReceived ? pct(s.totalActualProfit / s.totalActualReceived * 100) : '—'
      default:
        if (c.empId && c.key.endsWith(':earn')) return inr(empEarnTotals[c.empId] ?? 0, dp)
        return ''
    }
  }

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

          {/* Group by — partition rows into collapsible, subtotaled sections */}
          <div className="flex items-center gap-1 ml-1 pl-2 border-l border-border">
            <Layers className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">Group:</span>
            <select
              value={groupKey}
              onChange={e => { setGroupKey(e.target.value as GroupKey); setCollapsed(new Set()) }}
              className="bg-secondary border border-border rounded-md px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-purple-500"
            >
              {GROUP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {groupKey !== 'none' && (
              <>
                <button onClick={collapseAll} title="Collapse all groups" className="px-1.5 py-1 rounded-md text-[11px] leading-none border border-border text-muted-foreground hover:text-foreground">−</button>
                <button onClick={expandAll} title="Expand all groups" className="px-1.5 py-1 rounded-md text-[11px] leading-none border border-border text-muted-foreground hover:text-foreground">+</button>
              </>
            )}
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

            {/* ── Column order panel ── */}
            <div className="relative" ref={colOrderPanelRef}>
              <button
                onClick={() => setShowColOrderPanel(v => !v)}
                title="Reorder columns"
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  showColOrderPanel
                    ? 'bg-foreground/10 border-foreground/20 text-foreground'
                    : 'bg-card border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                <GripVertical className="w-4 h-4" />
                Columns
              </button>
              {showColOrderPanel && (
                <div className="absolute top-full right-0 mt-1.5 z-50 bg-card border border-border rounded-xl shadow-2xl p-3 min-w-[240px]">
                  <div className="flex items-center justify-between mb-2 px-1">
                    <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Column order</span>
                    <button
                      onClick={() => setColOrder([...DEFAULT_COL_ORDER])}
                      className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                      title="Reset to default order"
                    >
                      Reset
                    </button>
                  </div>
                  <div className="space-y-0.5 max-h-72 overflow-y-auto">
                    {(() => {
                      // Build the ordered list of non-employee columns
                      const fixedCols = allColumns.filter(c => c.group !== 'employees')
                      return fixedCols.map((col, i) => (
                        <div
                          key={col.key}
                          className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-secondary/60 group/row"
                        >
                          {/* Up / down buttons */}
                          <div className="flex flex-col shrink-0">
                            <button
                              onClick={() => moveCol(col.key, -1)}
                              disabled={i === 0}
                              className="p-0.5 rounded text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors"
                              title="Move up"
                            >
                              <ChevronUp className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => moveCol(col.key, 1)}
                              disabled={i === fixedCols.length - 1}
                              className="p-0.5 rounded text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors"
                              title="Move down"
                            >
                              <ChevronDown className="w-3 h-3" />
                            </button>
                          </div>
                          <GripVertical className="w-3 h-3 shrink-0 text-muted-foreground/30 group-hover/row:text-muted-foreground/60" />
                          <span className="text-xs flex-1 truncate">{col.label}</span>
                          {/* Group badge */}
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium shrink-0 ${
                            col.group === 'core'    ? 'bg-foreground/5 text-muted-foreground/60' :
                            col.group === 'billing' ? 'bg-blue-500/10 text-blue-400/70' :
                                                      'bg-emerald-500/10 text-emerald-400/70'
                          }`}>
                            {col.group}
                          </span>
                        </div>
                      ))
                    })()}
                  </div>
                  <p className="text-[10px] text-muted-foreground/60 mt-2 px-1 border-t border-border pt-2">
                    Employee columns always appear at the end.
                  </p>

                  {/* ── Saved layouts (this captures order + visible groups + frozen + sort) ── */}
                  <div className="mt-2 pt-2 border-t border-border space-y-1">
                    <span className="block text-[11px] font-semibold text-muted-foreground uppercase tracking-wide px-1 mb-1">Saved layouts</span>

                    <button
                      onClick={handleSavePersonal}
                      disabled={savingLayout !== null}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs hover:bg-secondary/60 disabled:opacity-50 transition-colors"
                    >
                      <Save className="w-3.5 h-3.5 shrink-0 text-purple-400" />
                      <span className="flex-1 text-left">Save current as my default</span>
                      {savingLayout === 'personal' && <span className="w-3 h-3 border-2 border-foreground/20 border-t-purple-400 rounded-full animate-spin" />}
                    </button>

                    {isAdmin && (
                      <button
                        onClick={handleSaveSystem}
                        disabled={savingLayout !== null}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs hover:bg-secondary/60 disabled:opacity-50 transition-colors"
                      >
                        <Building2 className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                        <span className="flex-1 text-left">Set current as system default</span>
                        <span className="text-[9px] px-1 py-0.5 rounded-full bg-amber-500/10 text-amber-400/80 font-medium shrink-0">admin</span>
                        {savingLayout === 'system' && <span className="w-3 h-3 border-2 border-foreground/20 border-t-amber-400 rounded-full animate-spin" />}
                      </button>
                    )}

                    <div className="h-px bg-border my-1" />

                    <button
                      onClick={handleResetMine}
                      disabled={savingLayout !== null}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs hover:bg-secondary/60 disabled:opacity-50 transition-colors"
                    >
                      <RotateCcw className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                      <span className="flex-1 text-left">Reset to my default</span>
                    </button>

                    <button
                      onClick={handleResetSystem}
                      disabled={savingLayout !== null}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs hover:bg-secondary/60 disabled:opacity-50 transition-colors"
                    >
                      <RotateCcw className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                      <span className="flex-1 text-left">Reset to system default</span>
                    </button>

                    {layoutMsg && (
                      <div className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] ${
                        layoutMsg.kind === 'ok' ? 'text-emerald-400 bg-emerald-500/10' : 'text-red-400 bg-red-500/10'
                      }`}>
                        {layoutMsg.kind === 'ok' ? <Check className="w-3 h-3 shrink-0" /> : <X className="w-3 h-3 shrink-0" />}
                        <span className="truncate">{layoutMsg.text}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* ── Freeze columns panel ── */}
            <div className="relative" ref={freezePanelRef}>
              <button
                onClick={() => setShowFreezePanel(v => !v)}
                title="Manage frozen columns"
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  frozenCols.size > 0
                    ? 'gradient-bg text-white border-transparent'
                    : 'bg-card border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                <Pin className="w-4 h-4" />
                Freeze{frozenCols.size > 0 ? ` (${frozenCols.size})` : ''}
              </button>
              {showFreezePanel && (
                <div className="absolute top-full right-0 mt-1.5 z-50 bg-card border border-border rounded-xl shadow-2xl p-3 min-w-[220px]">
                  <div className="flex items-center justify-between mb-2 px-1">
                    <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Freeze columns</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setFrozenCols(new Set(DEFAULT_FROZEN_COLS))}
                        className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                        title="Restore default frozen columns"
                      >
                        Default
                      </button>
                      <span className="text-border text-[10px]">·</span>
                      <button
                        onClick={() => setFrozenCols(new Set())}
                        className="text-[10px] text-red-400/70 hover:text-red-400 transition-colors"
                        title="Unfreeze all columns"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  <div className="space-y-0.5 max-h-64 overflow-y-auto">
                    {columns.filter(c => c.group !== 'employees').map(c => {
                      const isFrozen = frozenCols.has(c.key)
                      return (
                        <label key={c.key} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-secondary/60 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={isFrozen}
                            onChange={() => toggleFreeze(c.key)}
                            className="accent-purple-500 shrink-0"
                          />
                          <Pin className={`w-3 h-3 shrink-0 transition-colors ${isFrozen ? 'text-purple-400' : 'text-muted-foreground/30'}`} />
                          <span className="text-xs truncate">{c.label}</span>
                        </label>
                      )
                    })}
                  </div>
                  <p className="text-[10px] text-muted-foreground/60 mt-2 px-1 border-t border-border pt-2">
                    Hover any column header and click <Pin className="w-2.5 h-2.5 inline" /> to pin/unpin.
                  </p>
                </div>
              )}
            </div>

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
              <div className="sticky top-0 z-20 grid bg-secondary border-b border-border" style={{ gridTemplateColumns: gridTemplate, gridTemplateRows: 'auto auto auto' }}>
                {/* Fixed columns — span both header rows */}
                {columns.slice(0, fixedCount).map((c, ci) => {
                  const active = sortKey === c.key
                  const isFrozen = frozenCols.has(c.key)
                  const isLast = c.key === lastFrozenKey
                  const frozenLeft = frozenLeftMap.get(c.key) ?? 0
                  return (
                    <button
                      key={c.key} onClick={() => toggleSort(c.key)}
                      style={{
                        gridColumn: `${ci + 1} / ${ci + 2}`, gridRow: '1 / 3',
                        ...(isFrozen ? { left: frozenLeft } : {}),
                      }}
                      className={`group/hdr relative flex items-center gap-0.5 px-2 py-2 text-[11px] font-semibold whitespace-nowrap hover:bg-secondary/70 ${
                        c.align === 'right' ? 'justify-end' : c.align === 'center' ? 'justify-center' : 'justify-start'
                      } ${active ? 'text-purple-400' : 'text-muted-foreground'} ${
                        isFrozen ? 'sticky z-30 bg-secondary' : ''
                      } ${isLast ? 'border-r-2 border-purple-500/30' : ''}`}
                    >
                      <span className="truncate">{c.label}</span>
                      {active && (sortDir === 'asc' ? <ArrowUp className="w-3 h-3 shrink-0" /> : <ArrowDown className="w-3 h-3 shrink-0" />)}
                      {/* Always-visible frozen indicator */}
                      {isFrozen && (
                        <Pin className="w-2.5 h-2.5 shrink-0 ml-0.5 text-purple-400/60" />
                      )}
                      {/* Pin / unpin toggle — visible on header hover */}
                      <span
                        role="button"
                        onClick={e => { e.stopPropagation(); toggleFreeze(c.key) }}
                        title={isFrozen ? 'Unfreeze column' : 'Freeze column'}
                        className={`absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover/hdr:flex w-5 h-5 items-center justify-center rounded transition-colors cursor-pointer z-10 ${
                          isFrozen
                            ? 'text-purple-400 hover:text-purple-300 bg-secondary/80'
                            : 'text-muted-foreground/50 hover:text-foreground bg-secondary/60'
                        }`}
                      >
                        <Pin className="w-3 h-3" />
                      </span>
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
                {/* Totals row — sums for the current filter, pinned under the header */}
                {columns.map((c, ci) => {
                  const isFrozen = frozenCols.has(c.key)
                  const isLast = c.key === lastFrozenKey
                  const frozenLeft = frozenLeftMap.get(c.key) ?? 0
                  return (
                    <div
                      key={`tot:${c.key}`}
                      style={{
                        gridColumn: `${ci + 1} / ${ci + 2}`, gridRow: '3 / 4',
                        ...(isFrozen ? { left: frozenLeft } : {}),
                      }}
                      className={`flex items-center px-2 py-1.5 text-[11px] font-bold whitespace-nowrap bg-secondary border-t-2 border-purple-500/40 text-purple-300 ${
                        c.align === 'right' ? 'justify-end' : c.align === 'center' ? 'justify-center' : 'justify-start'
                      } ${isFrozen ? 'sticky z-30 bg-secondary' : ''} ${isLast ? 'border-r-2 border-purple-500/30' : ''}`}
                    >
                      <span className="truncate">{grandTotalCell(c)}</span>
                    </div>
                  )
                })}
              </div>

              {/* Virtualized body (data rows + optional group headers / subtotals) */}
              {sorted.length === 0 ? (
                <div className="p-10 text-center text-sm text-muted-foreground">No tasks match the current filters.</div>
              ) : (
                <div style={{ height: totalH, position: 'relative' }}>
                  {visible.map((it, k) => {
                    const i = startIdx + k
                    const topPx = offsets[i]

                    if (it.kind === 'group') {
                      const isCollapsed = collapsed.has(it.group.key)
                      return (
                        <div
                          key={`g:${it.group.key}`}
                          className="absolute left-0 right-0 flex items-stretch bg-secondary/50 border-y border-border"
                          style={{ top: topPx, height: it.h }}
                        >
                          <button
                            onClick={() => toggleCollapse(it.group.key)}
                            className="sticky left-0 z-10 flex items-center gap-1.5 px-3 bg-secondary/50 hover:bg-secondary/80 text-left"
                            style={{ height: it.h }}
                          >
                            <ChevronDown className={`w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                            <Layers className="w-3.5 h-3.5 shrink-0 text-purple-400" />
                            <span className="text-xs font-semibold truncate">{it.group.label}</span>
                            <span className="text-[11px] text-muted-foreground">({fmt(it.group.summary.totalTasks, 0)})</span>
                          </button>
                        </div>
                      )
                    }

                    if (it.kind === 'subtotal') {
                      return (
                        <div
                          key={`s:${it.group.key}`}
                          className="absolute left-0 right-0 grid bg-secondary/20 border-b border-border"
                          style={{ top: topPx, height: it.h, gridTemplateColumns: gridTemplate }}
                        >
                          {columns.map((c, ci) => {
                            const groupStart = ci >= fixedCount && (ci - fixedCount) % 3 === 0
                            const isFrozen = frozenCols.has(c.key)
                            const isLast = c.key === lastFrozenKey
                            const frozenLeft = frozenLeftMap.get(c.key) ?? 0
                            return (
                              <div
                                key={c.key}
                                style={isFrozen ? { left: frozenLeft } : {}}
                                className={`px-2 flex items-center text-[11px] font-semibold whitespace-nowrap overflow-hidden tabular-nums ${
                                  c.align === 'right' ? 'justify-end' : c.align === 'center' ? 'justify-center' : 'justify-start'
                                } ${isFrozen ? 'sticky z-10 bg-card' : ''} ${isLast ? 'border-r-2 border-purple-500/10' : ''} ${groupStart ? 'border-l border-border/60' : ''} ${subColor(c.key, it.group.summary)}`}
                              >
                                <span className="truncate">{subtotalCell(c, it.group)}</span>
                              </div>
                            )
                          })}
                        </div>
                      )
                    }

                    // data row
                    const r = it.row
                    const rowBg = it.z % 2 ? 'bg-secondary/10' : ''
                    return (
                      <div
                        key={r.task_id}
                        className={`grid absolute left-0 right-0 border-b border-border/50 hover:bg-secondary/40 ${rowBg}`}
                        style={{ top: topPx, height: ROW_H, gridTemplateColumns: gridTemplate }}
                      >
                        {columns.map((c, ci) => {
                          const groupStart = ci >= fixedCount && (ci - fixedCount) % 3 === 0
                          const isFrozen = frozenCols.has(c.key)
                          const isLast = c.key === lastFrozenKey
                          const frozenLeft = frozenLeftMap.get(c.key) ?? 0
                          return (
                            <div
                              key={c.key}
                              style={isFrozen ? { left: frozenLeft } : {}}
                              className={`px-2 flex items-center text-xs whitespace-nowrap overflow-hidden tabular-nums ${
                                c.align === 'right' ? 'justify-end' : c.align === 'center' ? 'justify-center' : 'justify-start'
                              } ${isFrozen ? 'sticky z-10 bg-card' : ''} ${isLast ? 'border-r-2 border-purple-500/10' : ''} ${groupStart ? 'border-l border-border/60' : ''} ${c.cls ? c.cls(r) : ''}`}
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

          {/* Footer — pagination is bypassed while grouping (all groups shown) */}
          <div className="flex items-center justify-between gap-3 px-3 py-2 border-t border-border text-xs">
            {groupKey === 'none' ? (
              <>
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
              </>
            ) : (
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Layers className="w-3.5 h-3.5" />
                <span>
                  <span className="font-semibold text-foreground">{fmt(grouped.length, 0)}</span>{' '}
                  {GROUP_OPTIONS.find(o => o.value === groupKey)?.label.toLowerCase()} groups ·{' '}
                  <span className="font-semibold text-foreground">{fmt(sorted.length, 0)}</span> tasks · all shown
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
