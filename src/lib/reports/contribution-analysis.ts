/**
 * Contribution Analysis Report — shared types + pure helpers.
 *
 * One ROW per task. Employee contribution % and earnings are pivoted into
 * dynamic per-employee columns. All figures come from STORED data
 * (contribution_scores) — this is a reporting/BI view, NOT a recalculation.
 *
 * Used by both the server page (row assembly) and the client (filter / sort /
 * summary / export), so everything here is pure and isomorphic.
 */

export type EarningSource = 'contribution' | 'manual_override'

// ─── Column / row shapes ──────────────────────────────────────────────────────

export interface EmployeeColumn {
  id: string
  name: string
  cqid: string
}

export interface EmpCell {
  /** stored contribution_scores.score_percentage (0 when employee didn't contribute) */
  pct: number
  /** stored contribution_scores.earnings_inr */
  earn: number
  /** how `earn` was derived: contribution (normal) | manual_override */
  source?: EarningSource
}

export interface AnalysisRow {
  task_id: string
  task_number: number | null
  /** Task title / name (e.g. "Money Saver") */
  title: string
  task_date: string
  client_id: string
  client_name: string
  service_id: string
  service_name: string
  status: string
  currency: string
  /** billing in the task's own currency */
  billing: number
  /** billing in INR (company base) */
  billing_inr: number
  commission_pct: number
  /** billing_inr × commission_pct / 100 — the intended employee pool */
  commission_pool: number
  /** Σ stored earnings_inr across all employees on the task */
  total_earnings: number
  /** = billing_inr (what the company received for the task) */
  company_received: number
  /** EXPECTED profit: billing_inr − total_earnings (locked INR basis) */
  profit: number
  /** expected profit / billing_inr × 100 (0 when billing_inr = 0) */
  profit_pct: number
  // ── Actual / FX (informational; null until the linked invoice is fully paid) ──
  /** task's share of the linked invoice's actual INR received; null if not yet
   *  fully collected or not invoiced */
  actual_received: number | null
  /** actual_received − billing_inr (locked). +ve = FX gain, −ve = FX loss. null = pending */
  fx_gain_loss: number | null
  /** actual_received − total_earnings. null = pending */
  actual_profit: number | null
  /** actual_profit / actual_received × 100. null = pending */
  actual_profit_pct: number | null
  /** number of employees with a contribution (pct > 0) on this task */
  contributors: number
  /** employeeId → { pct, earn } */
  emp: Record<string, EmpCell>
}

// ─── Raw inputs from the DB (server-side) ─────────────────────────────────────

export interface RawTask {
  id: string
  task_number: number | null
  title: string | null
  task_date: string
  status: string
  currency: string | null
  billing_amount: number | null
  billing_amount_inr: number | null
  client_id: string | null
  service_id: string | null
}
export interface RawScore {
  task_id: string
  employee_id: string
  score_percentage: number | null
  earnings_inr: number | null
  is_manual_override?: boolean | null
}
export interface RawPricing {
  client_id: string
  service_id: string
  commission_percentage: number | null
}

const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * Assemble one AnalysisRow per task. Pure — runs on the server during the page
 * load, but has no server dependencies so it is unit-testable.
 */
export function buildAnalysisRows(
  tasks: RawTask[],
  scores: RawScore[],
  pricing: RawPricing[],
  clientName: Map<string, string>,
  serviceName: Map<string, string>,
  /** task_id → actual INR received (apportioned). Absent/undefined ⇒ pending. */
  actualByTask: Map<string, number> = new Map(),
  defaultCommissionPct = 50,
  /** employee_id → performance_rating (0–100). Drives the earnings formula. */
  empRating: Map<string, number> = new Map(),
  /** task_id → Σ tool fixed_percentage used on the task (flat pool deduction). */
  toolPctByTask: Map<string, number> = new Map(),
  /** Rating assumed when an employee has no record (neutral = no penalty). */
  defaultPerformanceRating = 100,
): AnalysisRow[] {
  // HISTORICAL READER CONTRACT: `pricing` must be passed in UNFILTERED by
  // is_active. is_active governs what a client may be SOLD today, never what
  // was EARNED — narrowing it would reprice every past task on a deactivated
  // pair to defaultCommissionPct. Callers: contribution-analysis/page.tsx,
  // what-if/page.tsx.
  const pmap = new Map<string, number>()
  for (const p of pricing) {
    if (p.commission_percentage != null) pmap.set(`${p.client_id}|${p.service_id}`, p.commission_percentage)
  }

  // Group scores by task.
  const byTask = new Map<string, RawScore[]>()
  for (const s of scores) {
    const arr = byTask.get(s.task_id)
    if (arr) arr.push(s)
    else byTask.set(s.task_id, [s])
  }

  const rows: AnalysisRow[] = []
  for (const t of tasks) {
    const billing_inr = t.billing_amount_inr || 0
    const basis_inr = billing_inr
    const commission_pct = (t.client_id && t.service_id)
      ? (pmap.get(`${t.client_id}|${t.service_id}`) ?? defaultCommissionPct)
      : defaultCommissionPct

    const commission_pool = r2(basis_inr * commission_pct / 100)
    // Tools deduct a flat % of the pool first (mirrors the live commission
    // engine). `remainingPool` is what employees actually split.
    const toolPct = toolPctByTask.get(t.id) || 0
    const remainingPool = commission_pool * (1 - toolPct / 100)

    const taskScores = byTask.get(t.id) || []
    const emp: Record<string, EmpCell> = {}
    let total_earnings = 0
    let contributors = 0
    for (const s of taskScores) {
      const pct = s.score_percentage || 0
      const rating = empRating.get(s.employee_id) ?? defaultPerformanceRating
      // Mirror the live commission engine EXACTLY:
      //   earnings = remainingPool × (score%/100) × (performanceRating/100)
      // score_percentage is the employee's normalised SHARE (0–100) of the
      // pool BEFORE the rating multiplier — so the rating must be applied here.
      // Recomputed from CURRENT billing + rating so the report always matches
      // the live Contributions page, even after a billing/quantity edit (stored
      // earnings_inr can be stale until the contribution is re-saved).
      const earn = r2(remainingPool * (pct / 100) * (rating / 100))
      const source: EarningSource = s.is_manual_override ? 'manual_override' : 'contribution'

      emp[s.employee_id] = { pct: r2(pct), earn, source }
      total_earnings += earn
      if (pct > 0) contributors++
    }
    total_earnings = r2(total_earnings)
    const profit = r2(basis_inr - total_earnings)
    const profit_pct = basis_inr > 0 ? r2(profit / basis_inr * 100) : 0

    // Actual / FX — only when the linked invoice is fully paid (value present).
    const ar = actualByTask.get(t.id)
    const actual_received = ar === undefined ? null : r2(ar)
    const fx_gain_loss = actual_received === null ? null : r2(actual_received - billing_inr)
    const actual_profit = actual_received === null ? null : r2(actual_received - total_earnings)
    const actual_profit_pct = actual_received === null
      ? null
      : (actual_received > 0 ? r2((actual_received - total_earnings) / actual_received * 100) : 0)

    rows.push({
      task_id: t.id,
      task_number: t.task_number,
      title: t.title || '—',
      task_date: t.task_date,
      client_id: t.client_id || '',
      client_name: (t.client_id && clientName.get(t.client_id)) || '—',
      service_id: t.service_id || '',
      service_name: (t.service_id && serviceName.get(t.service_id)) || '—',
      status: t.status,
      currency: t.currency || 'INR',
      billing: t.billing_amount || 0,
      billing_inr,
      commission_pct,
      commission_pool,
      total_earnings,
      company_received: billing_inr,
      profit,
      profit_pct,
      actual_received,
      fx_gain_loss,
      actual_profit,
      actual_profit_pct,
      contributors,
      emp,
    })
  }
  return rows
}

// ─── Filtering ────────────────────────────────────────────────────────────────

export interface Filters {
  date: any // DateFilterValue from UI
  clientIds: string[]
  serviceIds: string[]
  employeeIds: string[]
  statuses: string[]
  billingMin: string
  billingMax: string
  profitMin: string
  profitMax: string
  profitPctMin: string
  profitPctMax: string
  earnMin: string
  earnMax: string
}

export const EMPTY_FILTERS: Filters = {
  date: null,
  clientIds: [], serviceIds: [], employeeIds: [], statuses: [],
  billingMin: '', billingMax: '', profitMin: '', profitMax: '',
  profitPctMin: '', profitPctMax: '', earnMin: '', earnMax: '',
}

const numOr = (s: string, fallback: number) => {
  const n = parseFloat(s)
  return isNaN(n) ? fallback : n
}

export function applyFilters(rows: AnalysisRow[], f: Filters): AnalysisRow[] {
  const clientSet = f.clientIds.length ? new Set(f.clientIds) : null
  const serviceSet = f.serviceIds.length ? new Set(f.serviceIds) : null
  const statusSet = f.statuses.length ? new Set(f.statuses) : null
  const bMin = numOr(f.billingMin, -Infinity), bMax = numOr(f.billingMax, Infinity)
  const pMin = numOr(f.profitMin, -Infinity), pMax = numOr(f.profitMax, Infinity)
  const ppMin = numOr(f.profitPctMin, -Infinity), ppMax = numOr(f.profitPctMax, Infinity)
  const eMin = numOr(f.earnMin, -Infinity), eMax = numOr(f.earnMax, Infinity)

  return rows.filter(row => {
    if (clientSet && !clientSet.has(row.client_id)) return false
    if (serviceSet && !serviceSet.has(row.service_id)) return false
    if (statusSet && !statusSet.has(row.status)) return false
    if (f.employeeIds && f.employeeIds.length > 0) {
      if (!f.employeeIds.some(empId => row.emp[empId]?.pct > 0)) return false
    }
    if (row.billing_inr < bMin || row.billing_inr > bMax) return false
    if (row.profit < pMin || row.profit > pMax) return false
    if (row.profit_pct < ppMin || row.profit_pct > ppMax) return false
    if (row.total_earnings < eMin || row.total_earnings > eMax) return false
    return true
  })
}

// ─── Sorting ──────────────────────────────────────────────────────────────────

export type SortDir = 'asc' | 'desc'
// Fixed keys, or dynamic 'emp:<id>:pct' | 'emp:<id>:earn'
export type SortKey =
  | 'task_number' | 'title' | 'task_date' | 'client_name' | 'service_name' | 'status'
  | 'billing_inr' | 'commission_pool' | 'total_earnings' | 'profit' | 'profit_pct'
  | 'contributors' | string

/** Employee earnings as a % of the task's INR billing (revenue share). */
export function empShare(row: AnalysisRow, employeeId: string): number {
  const earn = row.emp[employeeId]?.earn ?? 0
  return row.billing_inr > 0 ? Math.round(earn / row.billing_inr * 100 * 100) / 100 : 0
}

function sortValue(row: AnalysisRow, key: SortKey): number | string {
  if (key.startsWith('emp:')) {
    const [, id, field] = key.split(':')
    const cell = row.emp[id]
    if (field === 'earn') return cell?.earn ?? 0
    if (field === 'share') return empShare(row, id)
    return cell?.pct ?? 0
  }
  const v = (row as any)[key]
  return v ?? (typeof v === 'string' ? '' : 0)
}

export function sortRows(rows: AnalysisRow[], key: SortKey, dir: SortDir): AnalysisRow[] {
  const mul = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key), bv = sortValue(b, key)
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av).localeCompare(String(bv)) * mul
    }
    return (av - bv) * mul
  })
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export interface Summary {
  totalTasks: number
  totalBilling: number
  totalPool: number
  totalEarnings: number
  /** expected company profit (locked INR basis) */
  totalProfit: number
  avgProfitPct: number
  avgContributionPct: number
  // ── Actual / FX (only over tasks whose invoice is fully paid) ──
  /** number of tasks with a fully-paid (actual) result */
  actualTasks: number
  totalActualReceived: number
  totalFxGainLoss: number
  totalActualProfit: number
  // ── Filtered Employee Specific ──
  filteredEarnings?: number
  filteredAvgContrib?: number
}

export function computeSummary(rows: AnalysisRow[], employeeFilterIds?: string[]): Summary {
  let totalBilling = 0, totalPool = 0, totalEarnings = 0, totalProfit = 0
  let profitPctSum = 0, profitPctCount = 0
  let contribPctSum = 0, contribPctCount = 0
  let actualTasks = 0, totalActualReceived = 0, totalFxGainLoss = 0, totalActualProfit = 0
  
  let filteredEarnings = 0
  let filteredContribSum = 0, filteredContribCount = 0

  const hasEmpFilter = employeeFilterIds && employeeFilterIds.length > 0

  for (const r of rows) {
    totalBilling += r.billing_inr
    totalPool += r.commission_pool
    totalEarnings += r.total_earnings
    totalProfit += r.profit
    if (r.billing_inr > 0) { profitPctSum += r.profit_pct; profitPctCount++ }
    if (r.actual_received !== null) {
      actualTasks++
      totalActualReceived += r.actual_received
      totalFxGainLoss += r.fx_gain_loss ?? 0
      totalActualProfit += r.actual_profit ?? 0
    }
    
    // Calculate averages based on filters
    if (hasEmpFilter) {
      for (const id of employeeFilterIds) {
        if (r.emp[id]) {
          filteredEarnings += r.emp[id].earn
          const pct = r.emp[id].pct
          if (pct > 0) { filteredContribSum += pct; filteredContribCount++ }
        }
      }
    } else {
      for (const id in r.emp) {
        const pct = r.emp[id].pct
        if (pct > 0) { contribPctSum += pct; contribPctCount++ }
      }
    }
  }
  
  return {
    totalTasks: rows.length,
    totalBilling: r2(totalBilling),
    totalPool: r2(totalPool),
    totalEarnings: r2(totalEarnings),
    totalProfit: r2(totalProfit),
    avgProfitPct: profitPctCount ? r2(profitPctSum / profitPctCount) : 0,
    avgContributionPct: contribPctCount ? r2(contribPctSum / contribPctCount) : 0,
    actualTasks,
    totalActualReceived: r2(totalActualReceived),
    totalFxGainLoss: r2(totalFxGainLoss),
    totalActualProfit: r2(totalActualProfit),
    ...(hasEmpFilter ? {
      filteredEarnings: r2(filteredEarnings),
      filteredAvgContrib: filteredContribCount ? r2(filteredContribSum / filteredContribCount) : 0
    } : {})
  }
}

// ─── Export (flat matrix shared by CSV + XLSX) ────────────────────────────────

/** Column index of each numeric metric in the export matrix — lets callers
 *  (e.g. group subtotal rows) place values under the right header. */
export const MATRIX_COL = {
  // pos 0 = task_number (also used as label cell for group subtotal rows)
  label: 0,
  // pos 1 = title (NEW — shifts all subsequent indices by +1)
  title: 1,
  // pos 2..6 = task_date, client_name, service_name, status, currency, billing
  billing_inr: 8, commission_pool: 10, total_earnings: 11,
  company_received: 12, exp_profit: 13, exp_profit_pct: 14, actual_received: 15,
  fx_gain_loss: 16, actual_profit: 17, actual_profit_pct: 18, contributors: 19,
} as const

/** Fixed (non-employee) column count in the export matrix. Each employee adds 3. */
export const MATRIX_FIXED_COLS = 20

const blankNum = (n: number | null) => (n === null ? '' : n)

export function matrixHeader(employees: EmployeeColumn[]): string[] {
  const header: string[] = [
    'Task Number', 'Task Title', 'Task Date', 'Client', 'Service', 'Status',
    'Currency', 'Billing Amount', 'Billing Amount (INR, Locked)', 'Commission %',
    'Commission Pool (INR)', 'Total Employee Earnings (INR)',
    'Company Received (INR)', 'Expected Profit (INR)', 'Expected Profit %',
    'Actual Received (INR)', 'FX Gain/Loss (INR)', 'Actual Profit (INR)', 'Actual Profit %',
    'Total Contributors',
  ]
  for (const e of employees) {
    // Callers pass `displayEmployees`, already masked with dn(), so the CSV carries CQIDs when locked.
    // eslint-disable-next-line no-restricted-syntax -- pre-masked by the caller (see above)
    header.push(`${e.name} Contribution %`, `${e.name} Earnings ₹`, `${e.name} Earnings % of Billing`)
  }
  return header
}

export function rowToLine(r: AnalysisRow, employees: EmployeeColumn[]): (string | number)[] {
  const line: (string | number)[] = [
    r.task_number ?? '', r.title, r.task_date, r.client_name, r.service_name, r.status,
    r.currency, r.billing, r.billing_inr, r.commission_pct,
    r.commission_pool, r.total_earnings,
    r.company_received, r.profit, r.profit_pct,
    blankNum(r.actual_received), blankNum(r.fx_gain_loss), blankNum(r.actual_profit), blankNum(r.actual_profit_pct),
    r.contributors,
  ]
  for (const e of employees) {
    const cell = r.emp[e.id]
    line.push(cell?.pct ?? 0, cell?.earn ?? 0, empShare(r, e.id))
  }
  return line
}

/** Header labels + 2-D data matrix, employee columns expanded. Filters/sort
 *  are already applied by the caller, so export always matches the screen. */
export function toMatrix(rows: AnalysisRow[], employees: EmployeeColumn[]): (string | number)[][] {
  return [matrixHeader(employees), ...rows.map(r => rowToLine(r, employees))]
}

export function matrixToCSV(matrix: (string | number)[][]): string {
  const esc = (v: string | number) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return matrix.map(row => row.map(esc).join(',')).join('\n')
}

// ─── Grouping (subtotaled views) ──────────────────────────────────────────────

export type GroupKey = 'none' | 'client' | 'service' | 'status' | 'month' | 'year'

export const GROUP_OPTIONS: { value: GroupKey; label: string }[] = [
  { value: 'none', label: 'No grouping' },
  { value: 'client', label: 'Client' },
  { value: 'service', label: 'Service' },
  { value: 'status', label: 'Status' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
]

export interface RowGroup {
  /** stable identity within the chosen grouping dimension */
  key: string
  /** human label for the group header */
  label: string
  rows: AnalysisRow[]
  /** subtotals over this group's rows (reuses the Summary shape) */
  summary: Summary
  /** Σ stored earnings_inr per employee within the group (for emp sub-columns) */
  empEarn: Record<string, number>
}

const MON_SHORT = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** [stableKey, displayLabel] for a row under the chosen grouping dimension. */
function groupBucket(r: AnalysisRow, key: GroupKey): [string, string] {
  switch (key) {
    case 'client':  return [r.client_id || '∅', r.client_name || '—']
    case 'service': return [r.service_id || '∅', r.service_name || '—']
    case 'status':  return [r.status || '∅', r.status || '—']
    case 'month': {
      const ym = (r.task_date || '').slice(0, 7)          // YYYY-MM
      if (!ym) return ['∅', '—']
      const mm = parseInt(ym.slice(5, 7), 10)
      return [ym, `${MON_SHORT[mm] || '??'} ${ym.slice(0, 4)}`]
    }
    case 'year': {
      const y = (r.task_date || '').slice(0, 4)
      return [y || '∅', y || '—']
    }
    default: return ['', '']
  }
}

/**
 * Partition already-filtered+sorted rows into ordered groups. Groups appear in
 * first-appearance order, so group order follows the caller's active sort. Each
 * group carries its own subtotals. `key === 'none'` returns [].
 */
export function groupRows(rows: AnalysisRow[], key: GroupKey): RowGroup[] {
  if (key === 'none') return []
  const order: string[] = []
  const buckets = new Map<string, AnalysisRow[]>()
  const labels = new Map<string, string>()
  for (const r of rows) {
    const [k, label] = groupBucket(r, key)
    let arr = buckets.get(k)
    if (!arr) { arr = []; buckets.set(k, arr); labels.set(k, label); order.push(k) }
    arr.push(r)
  }
  return order.map(k => {
    const groupRowsArr = buckets.get(k)!
    const empEarn: Record<string, number> = {}
    for (const r of groupRowsArr) {
      for (const id in r.emp) empEarn[id] = r2((empEarn[id] || 0) + r.emp[id].earn)
    }
    return { key: k, label: labels.get(k)!, rows: groupRowsArr, summary: computeSummary(groupRowsArr), empEarn }
  })
}

/** A subtotal matrix line for one group — values placed under the right columns
 *  via MATRIX_COL. Width matches matrixHeader(employees). */
export function subtotalLine(g: RowGroup, employees: EmployeeColumn[]): (string | number)[] {
  const width = MATRIX_FIXED_COLS + employees.length * 3
  const line: (string | number)[] = new Array(width).fill('')
  const s = g.summary
  line[MATRIX_COL.label] = `Subtotal — ${g.label} (${s.totalTasks})`
  line[MATRIX_COL.billing_inr] = s.totalBilling
  line[MATRIX_COL.company_received] = s.totalBilling
  line[MATRIX_COL.commission_pool] = s.totalPool
  line[MATRIX_COL.total_earnings] = s.totalEarnings
  line[MATRIX_COL.exp_profit] = s.totalProfit
  line[MATRIX_COL.exp_profit_pct] = s.avgProfitPct
  if (s.actualTasks > 0) {
    line[MATRIX_COL.actual_received] = s.totalActualReceived
    line[MATRIX_COL.fx_gain_loss] = s.totalFxGainLoss
    line[MATRIX_COL.actual_profit] = s.totalActualProfit
    line[MATRIX_COL.actual_profit_pct] = s.totalActualReceived > 0 ? r2(s.totalActualProfit / s.totalActualReceived * 100) : 0
  }
  // employee earnings sub-column (pct / share are left blank for a subtotal)
  employees.forEach((e, i) => { line[MATRIX_FIXED_COLS + i * 3 + 1] = g.empEarn[e.id] ?? 0 })
  return line
}

/** Grouped export matrix: header, then per group a banner row, its data rows,
 *  and a subtotal row. Column shape matches toMatrix so CSV/XLSX stay aligned. */
export function toMatrixGrouped(groups: RowGroup[], employees: EmployeeColumn[]): (string | number)[][] {
  const header = matrixHeader(employees)
  const matrix: (string | number)[][] = [header]
  for (const g of groups) {
    const banner: (string | number)[] = new Array(header.length).fill('')
    banner[0] = `▸ ${g.label}`
    matrix.push(banner)
    for (const r of g.rows) matrix.push(rowToLine(r, employees))
    matrix.push(subtotalLine(g, employees))
  }
  return matrix
}
