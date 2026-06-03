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
}

export interface AnalysisRow {
  task_id: string
  task_number: number | null
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
): AnalysisRow[] {
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
    const commission_pct = (t.client_id && t.service_id)
      ? (pmap.get(`${t.client_id}|${t.service_id}`) ?? defaultCommissionPct)
      : defaultCommissionPct

    const taskScores = byTask.get(t.id) || []
    const emp: Record<string, EmpCell> = {}
    let total_earnings = 0
    let contributors = 0
    for (const s of taskScores) {
      const pct = s.score_percentage || 0
      const earn = s.earnings_inr || 0
      emp[s.employee_id] = { pct: r2(pct), earn: r2(earn) }
      total_earnings += earn
      if (pct > 0) contributors++
    }
    total_earnings = r2(total_earnings)

    const commission_pool = r2(billing_inr * commission_pct / 100)
    const profit = r2(billing_inr - total_earnings)
    const profit_pct = billing_inr > 0 ? r2(profit / billing_inr * 100) : 0

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
  from: string
  to: string
  month: string   // '1'..'12' or ''
  year: string    // '2026' or ''
  clientIds: string[]
  serviceIds: string[]
  employeeId: string   // "tasks containing this employee"
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
  from: '', to: '', month: '', year: '',
  clientIds: [], serviceIds: [], employeeId: '', statuses: [],
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
  const year = f.year ? parseInt(f.year, 10) : null
  const month = f.month ? parseInt(f.month, 10) : null

  return rows.filter(row => {
    const d = row.task_date || ''
    if (f.from && d < f.from) return false
    if (f.to && d > f.to) return false
    if (year !== null || month !== null) {
      // task_date is YYYY-MM-DD
      const yy = parseInt(d.slice(0, 4), 10)
      const mm = parseInt(d.slice(5, 7), 10)
      if (year !== null && yy !== year) return false
      if (month !== null && mm !== month) return false
    }
    if (clientSet && !clientSet.has(row.client_id)) return false
    if (serviceSet && !serviceSet.has(row.service_id)) return false
    if (statusSet && !statusSet.has(row.status)) return false
    if (f.employeeId && !((row.emp[f.employeeId]?.pct ?? 0) > 0)) return false
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
  | 'task_number' | 'task_date' | 'client_name' | 'service_name' | 'status'
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
}

export function computeSummary(rows: AnalysisRow[]): Summary {
  let totalBilling = 0, totalPool = 0, totalEarnings = 0, totalProfit = 0
  let profitPctSum = 0, profitPctCount = 0
  let contribPctSum = 0, contribPctCount = 0
  let actualTasks = 0, totalActualReceived = 0, totalFxGainLoss = 0, totalActualProfit = 0
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
    for (const id in r.emp) {
      const pct = r.emp[id].pct
      if (pct > 0) { contribPctSum += pct; contribPctCount++ }
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
  }
}

// ─── Export (flat matrix shared by CSV + XLSX) ────────────────────────────────

/** Header labels + 2-D data matrix, employee columns expanded. Filters/sort
 *  are already applied by the caller, so export always matches the screen. */
export function toMatrix(rows: AnalysisRow[], employees: EmployeeColumn[]): (string | number)[][] {
  const header: string[] = [
    'Task Number', 'Task Date', 'Client', 'Service', 'Status',
    'Currency', 'Billing Amount', 'Billing Amount (INR, Locked)', 'Commission %',
    'Commission Pool (INR)', 'Total Employee Earnings (INR)',
    'Company Received (INR)', 'Expected Profit (INR)', 'Expected Profit %',
    'Actual Received (INR)', 'FX Gain/Loss (INR)', 'Actual Profit (INR)', 'Actual Profit %',
    'Total Contributors',
  ]
  for (const e of employees) {
    header.push(`${e.name} Contribution %`, `${e.name} Earnings ₹`, `${e.name} Earnings % of Billing`)
  }

  const blank = (n: number | null) => (n === null ? '' : n)
  const matrix: (string | number)[][] = [header]
  for (const r of rows) {
    const line: (string | number)[] = [
      r.task_number ?? '', r.task_date, r.client_name, r.service_name, r.status,
      r.currency, r.billing, r.billing_inr, r.commission_pct,
      r.commission_pool, r.total_earnings,
      r.company_received, r.profit, r.profit_pct,
      blank(r.actual_received), blank(r.fx_gain_loss), blank(r.actual_profit), blank(r.actual_profit_pct),
      r.contributors,
    ]
    for (const e of employees) {
      const cell = r.emp[e.id]
      line.push(cell?.pct ?? 0, cell?.earn ?? 0, empShare(r, e.id))
    }
    matrix.push(line)
  }
  return matrix
}

export function matrixToCSV(matrix: (string | number)[][]): string {
  const esc = (v: string | number) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return matrix.map(row => row.map(esc).join(',')).join('\n')
}
