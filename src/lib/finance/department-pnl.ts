/**
 * Finance Engine — departmental P&L (pure).
 *
 * WHAT A "DEPARTMENT" IS HERE. The org_units table models departments properly
 * but scopes REVENUE ONLY (see lib/org/units.ts) and, more to the point, no
 * cost row in this database carries a unit: `cashbook_entries` has no unit
 * column and `employees` has no department. So a true department P&L — actual
 * rent for the Video team — is not derivable from the current schema.
 *
 * What IS derivable, at full coverage, is the DISCIPLINE a task was sold under:
 * task → service → service_category. This module treats a service category as
 * the department. Every rupee of revenue and every rupee of contribution
 * earnings carries that dimension already, so those two terms are ACTUAL, not
 * estimated.
 *
 *   revenue        − actual   task billing in the period
 *   direct labour  − actual   contribution earnings on those tasks
 *   = contribution margin
 *   allocated opex     − ESTIMATE, revenue-proportional
 *   allocated salaries − ESTIMATE, revenue-proportional
 *   = operating result
 *
 * THE TOP HALF IS MEASURED, THE BOTTOM HALF IS APPORTIONED, and the row type
 * keeps them in separate fields so a caller can never present an allocated
 * number as a measured one. A department that looks unprofitable only after
 * allocation is a different claim from one that loses money on its own work,
 * and `contributionMarginInr` is what distinguishes them.
 *
 * RECONCILIATION IS THE POINT. The allocation pools are the SAME terms the
 * profit engine subtracts (profit.ts: revenue − contribution − baseSalaries −
 * expenses), and `allocateOverhead` distributes them with largest-remainder so
 * the shares sum EXACTLY to the pool. Therefore
 *
 *   Σ rows.operatingResultInr === profit engine's profit for the period
 *
 * to the paise. `reconciliationInr` carries that sum so a page can assert it
 * rather than hope. Two reports that disagree about margin is the exact failure
 * docs/architecture/financial-core.md exists to prevent.
 *
 * NO DOUBLE COUNT. Direct labour is contribution earnings; the opex pool comes
 * from `expensesFromLines`, whose policy already excludes `opex.salaries` cash.
 * Base salaries enter once, as their own apportioned pool.
 *
 * THE CONTRIBUTION ENGINE IS NOT TOUCHED. This module only reads earnings the
 * contribution engine already stored.
 *
 * `buildEmployeeEarningsMatrix` decomposes the same direct-labour figure by
 * person, so the two views can be proved consistent: a department's column
 * total in the matrix equals its `directLabourInr` in the statement.
 */

import { allocateOverhead } from './overhead'

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100

/** Bucket id for work that carries no service, or a service with no category. */
export const UNASSIGNED_DEPARTMENT_ID = '__unassigned__'

/** The measured half of a department: both terms come from real rows. */
export interface DepartmentInput {
  departmentId: string
  departmentName: string
  /** Σ tasks.billing_amount_inr for the period. Actual. */
  revenueInr: number
  /** Σ contribution_scores.earnings_inr on those tasks. Actual. */
  directLabourInr: number
  /** How many tasks are behind the revenue — context for a thin department. */
  taskCount: number
}

export interface BuildDepartmentPnlOptions {
  /**
   * Company opex+cogs to apportion, EXCLUDING salaries (the profit engine's
   * `expensesInr`). Pass the same figure the profit engine used.
   */
  allocatableOpexInr: number
  /** Fixed pay to apportion (the profit engine's `baseSalariesInr`). */
  baseSalariesInr: number
}

export interface DepartmentPnlRow extends DepartmentInput {
  /** revenue − directLabour. MEASURED — no allocation in it. */
  contributionMarginInr: number
  /** margin ÷ revenue, one decimal. 0 when the department billed nothing. */
  contributionMarginPct: number
  /** Share of revenue — the allocation driver, shown so the split is auditable. */
  revenueSharePct: number
  /** APPORTIONED, not incurred. */
  allocatedOpexInr: number
  /** APPORTIONED, not incurred. */
  allocatedSalariesInr: number
  /** margin − allocatedOpex − allocatedSalaries. */
  operatingResultInr: number
  /** operatingResult ÷ revenue, one decimal. */
  operatingMarginPct: number
}

export interface DepartmentPnl {
  rows: DepartmentPnlRow[]
  totals: DepartmentPnlRow
  allocatableOpexInr: number
  baseSalariesInr: number
  /**
   * Σ rows.operatingResultInr. Equals the profit engine's profit for the same
   * period; a page that shows both can prove the report ties back.
   */
  reconciliationInr: number
}

const pct = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0

/**
 * Build the departmental P&L.
 *
 * Allocation is driven by revenue share. A department with zero or negative
 * revenue absorbs no overhead — `allocateOverhead` floors the basis at 0 —
 * which is deliberate: charging rent to a discipline that billed nothing would
 * manufacture a loss out of an accounting choice rather than reporting one.
 */
export function buildDepartmentPnl(
  inputs: DepartmentInput[],
  opts: BuildDepartmentPnlOptions,
): DepartmentPnl {
  const allocatableOpexInr = r2(opts.allocatableOpexInr)
  const baseSalariesInr = r2(opts.baseSalariesInr)

  const basis = inputs.map(i => ({ id: i.departmentId, billingInr: i.revenueInr }))
  const opexShare = allocateOverhead(allocatableOpexInr, basis)
  const salaryShare = allocateOverhead(baseSalariesInr, basis)

  const totalRevenue = inputs.reduce((s, i) => s + Math.max(0, i.revenueInr), 0)

  const rows: DepartmentPnlRow[] = inputs.map(i => {
    const margin = r2(i.revenueInr - i.directLabourInr)
    const allocatedOpexInr = opexShare.get(i.departmentId) ?? 0
    const allocatedSalariesInr = salaryShare.get(i.departmentId) ?? 0
    const operatingResultInr = r2(margin - allocatedOpexInr - allocatedSalariesInr)
    return {
      ...i,
      revenueInr: r2(i.revenueInr),
      directLabourInr: r2(i.directLabourInr),
      contributionMarginInr: margin,
      contributionMarginPct: pct(margin, i.revenueInr),
      revenueSharePct: pct(Math.max(0, i.revenueInr), totalRevenue),
      allocatedOpexInr,
      allocatedSalariesInr,
      operatingResultInr,
      operatingMarginPct: pct(operatingResultInr, i.revenueInr),
    }
  }).sort((a, b) => b.revenueInr - a.revenueInr)

  const sum = (f: (r: DepartmentPnlRow) => number) => r2(rows.reduce((s, r) => s + f(r), 0))
  const totalRevenueExact = sum(r => r.revenueInr)
  const totalMargin = sum(r => r.contributionMarginInr)
  const totalResult = sum(r => r.operatingResultInr)

  const totals: DepartmentPnlRow = {
    departmentId: '__totals__',
    departmentName: 'All departments',
    revenueInr: totalRevenueExact,
    directLabourInr: sum(r => r.directLabourInr),
    taskCount: rows.reduce((s, r) => s + r.taskCount, 0),
    contributionMarginInr: totalMargin,
    contributionMarginPct: pct(totalMargin, totalRevenueExact),
    revenueSharePct: rows.length > 0 ? 100 : 0,
    allocatedOpexInr: sum(r => r.allocatedOpexInr),
    allocatedSalariesInr: sum(r => r.allocatedSalariesInr),
    operatingResultInr: totalResult,
    operatingMarginPct: pct(totalResult, totalRevenueExact),
  }

  return {
    rows,
    totals,
    allocatableOpexInr,
    baseSalariesInr,
    reconciliationInr: totalResult,
  }
}

// ── Who earned it ────────────────────────────────────────────────────────────

/**
 * One person's earnings on one department's work.
 *
 * CQID ONLY — no `name` field exists here on purpose. Employee names must never
 * render (scripts/check-name-privacy.mjs gates the build on it), and a type
 * that cannot carry a name cannot leak one.
 */
export interface EmployeeEarningCell {
  employeeId: string
  employeeCqid: string
  departmentId: string
  earningsInr: number
  /** Tasks of that department this person scored on. */
  taskCount: number
}

export interface EmployeeEarningsRow {
  employeeId: string
  employeeCqid: string
  /** departmentId → earnings. Absent key means this person did none of that work. */
  byDepartment: Record<string, number>
  taskCountByDepartment: Record<string, number>
  totalInr: number
  totalTaskCount: number
  /** Share of ALL contribution earnings in the period. */
  sharePct: number
}

export interface EmployeeEarningsMatrix {
  rows: EmployeeEarningsRow[]
  /** departmentId → Σ earnings. Equals that department's directLabourInr. */
  departmentTotals: Record<string, number>
  grandTotalInr: number
}

/**
 * Pivot per-person, per-department earnings into a matrix.
 *
 * Rows sort by total earned, descending — the question this answers is "who
 * earned what", so the biggest earner leads. Department totals are returned
 * alongside so a caller can assert them against the statement's direct-labour
 * column; a mismatch means the two views disagree about the same rupees, which
 * is precisely the failure this engine's single-source rule exists to prevent.
 */
export function buildEmployeeEarningsMatrix(
  cells: EmployeeEarningCell[],
): EmployeeEarningsMatrix {
  const byEmployee = new Map<string, EmployeeEarningsRow>()
  const departmentTotals: Record<string, number> = {}

  for (const c of cells) {
    let row = byEmployee.get(c.employeeId)
    if (!row) {
      row = {
        employeeId: c.employeeId,
        employeeCqid: c.employeeCqid,
        byDepartment: {},
        taskCountByDepartment: {},
        totalInr: 0,
        totalTaskCount: 0,
        sharePct: 0,
      }
      byEmployee.set(c.employeeId, row)
    }
    row.byDepartment[c.departmentId] = r2((row.byDepartment[c.departmentId] ?? 0) + c.earningsInr)
    row.taskCountByDepartment[c.departmentId] =
      (row.taskCountByDepartment[c.departmentId] ?? 0) + c.taskCount
    row.totalInr = r2(row.totalInr + c.earningsInr)
    row.totalTaskCount += c.taskCount
    departmentTotals[c.departmentId] = r2((departmentTotals[c.departmentId] ?? 0) + c.earningsInr)
  }

  const rows = [...byEmployee.values()].sort((a, b) => b.totalInr - a.totalInr)
  const grandTotalInr = r2(rows.reduce((s, r) => s + r.totalInr, 0))
  for (const r of rows) r.sharePct = pct(r.totalInr, grandTotalInr)

  return { rows, departmentTotals, grandTotalInr }
}
