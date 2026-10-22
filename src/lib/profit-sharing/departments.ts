/**
 * Profit Sharing — department view (analysis only; nothing here changes a
 * share). Decided 2026-10-22: shared costs are apportioned by revenue.
 *
 * A department is a service category — the same dimension the Department P&L
 * report uses, because tasks, invoice lines and contribution earnings already
 * carry it; costs and employees do not.
 *
 *   own revenue_d   = the period's own revenue collected (the cash-profit
 *                     figure), split over each invoice's lines by department
 *   contribution_d  = contribution earnings on the period's tasks in d  (measured)
 *   shared pool     = everything else the cash profit deducts — operating
 *                     payments, base pay, bonuses, ownership, device costs,
 *                     write-offs — minus Σ contribution_d
 *   shared_d        = shared pool × d's share of own revenue           (estimate)
 *   result_d        = own revenue_d − contribution_d − shared_d
 *
 * Σ result_d equals the period's cash profit to the paisa, so this view can
 * never disagree with the figure the shares are computed from.
 */

import { round2 } from '@/lib/calculations/currency'
import { splitByWeight } from '@/lib/reports/ownership-allocation'

export const NO_DEPARTMENT = 'none'

export interface DepartmentInput {
  ownRevenueByInvoice: { invoiceId: string | null; amountInr: number }[]
  /** One row per invoice line: its department and its amount (any currency — only proportions matter). */
  invoiceLines: { invoiceId: string; deptId: string | null; amount: number }[]
  /** Contribution earnings on the period's tasks. */
  contributions: { employeeId: string; taskId: string; deptId: string | null; earningsInr: number }[]
  /** Assignments on the period's tasks (a role, with or without earnings). */
  assignments: { employeeId: string; taskId: string; deptId: string | null }[]
  /** The cash profit's deductions, as RunComputation.profit reports them (positive numbers). */
  deductions: {
    operatingPaymentsInr: number
    remunerationInr: number
    extraPayInr: number
    deviceCostsInr: number
    passthroughWriteoffsInr: number
    adWriteoffsInr: number
  }
  profitInr: number
}

export interface DepartmentRow {
  deptId: string
  ownRevenueInr: number
  revenueShare: number
  contributionPayInr: number
  sharedCostInr: number
  resultInr: number
  people: number
}

export interface EmployeeDepartmentRow {
  employeeId: string
  deptId: string
  earningsInr: number
  tasks: number
  /** Share of the department's contribution pay. */
  shareOfDeptPay: number
  /** Tasks in the department this person is assigned to without earning on them. */
  roleOnlyTasks: number
}

export interface DepartmentView {
  departments: DepartmentRow[]
  employees: EmployeeDepartmentRow[]
  sharedPoolInr: number
  /** Σ result − cash profit. Always 0; exposed so the page can show the check. */
  reconciliationInr: number
}

/** splitByWeight for any sign: splits the magnitude and gives the sign back. */
function split(total: number, weights: number[]): number[] {
  const parts = splitByWeight(Math.abs(total), weights)
  return total < 0 ? parts.map(p => -p) : parts
}

const key = (d: string | null) => d ?? NO_DEPARTMENT

export function departmentView(input: DepartmentInput): DepartmentView {
  const revenue = new Map<string, number>()
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, round2((m.get(k) ?? 0) + v))

  // Own revenue → departments, by each invoice's line amounts.
  const linesByInvoice = new Map<string, Map<string, number>>()
  for (const l of input.invoiceLines) {
    const m = linesByInvoice.get(l.invoiceId) ?? new Map<string, number>()
    add(m, key(l.deptId), Math.max(0, l.amount))
    linesByInvoice.set(l.invoiceId, m)
  }
  for (const r of input.ownRevenueByInvoice) {
    const lines = r.invoiceId ? linesByInvoice.get(r.invoiceId) : undefined
    if (!lines || lines.size === 0) { add(revenue, NO_DEPARTMENT, r.amountInr); continue }
    const depts = [...lines.keys()]
    const parts = split(r.amountInr, depts.map(d => lines.get(d) ?? 0))
    depts.forEach((d, i) => add(revenue, d, parts[i]))
  }

  // Contribution pay and people per department.
  const pay = new Map<string, number>()
  const byPerson = new Map<string, EmployeeDepartmentRow>()
  const person = (employeeId: string, deptId: string) => {
    const k = `${employeeId}|${deptId}`
    let row = byPerson.get(k)
    if (!row) { row = { employeeId, deptId, earningsInr: 0, tasks: 0, shareOfDeptPay: 0, roleOnlyTasks: 0 }; byPerson.set(k, row) }
    return row
  }
  const earnedTasks = new Set<string>()
  for (const c of input.contributions) {
    const d = key(c.deptId)
    add(pay, d, c.earningsInr)
    const row = person(c.employeeId, d)
    row.earningsInr = round2(row.earningsInr + c.earningsInr)
    row.tasks += 1
    earnedTasks.add(`${c.employeeId}|${c.taskId}`)
  }
  for (const a of input.assignments) {
    if (earnedTasks.has(`${a.employeeId}|${a.taskId}`)) continue
    person(a.employeeId, key(a.deptId)).roleOnlyTasks += 1
  }

  // The shared pool, apportioned by own-revenue share (decided).
  const d = input.deductions
  const totalDeductions = round2(d.operatingPaymentsInr + d.remunerationInr + d.extraPayInr + d.deviceCostsInr
    + d.passthroughWriteoffsInr + d.adWriteoffsInr)
  const totalPay = round2([...pay.values()].reduce((s, v) => s + v, 0))
  const sharedPool = round2(totalDeductions - totalPay)

  const depts = [...new Set([...revenue.keys(), ...pay.keys()])]
  if (depts.length === 0) depts.push(NO_DEPARTMENT)
  const totalRevenue = round2(depts.reduce((s, k) => s + Math.max(0, revenue.get(k) ?? 0), 0))
  const shared = split(sharedPool, depts.map(k => Math.max(0, revenue.get(k) ?? 0)))

  const departments: DepartmentRow[] = depts.map((deptId, i) => {
    const own = revenue.get(deptId) ?? 0
    const contrib = pay.get(deptId) ?? 0
    return {
      deptId,
      ownRevenueInr: round2(own),
      revenueShare: totalRevenue > 0 ? Math.max(0, own) / totalRevenue : 0,
      contributionPayInr: round2(contrib),
      sharedCostInr: shared[i],
      resultInr: round2(own - contrib - shared[i]),
      people: [...byPerson.values()].filter(p => p.deptId === deptId).length,
    }
  }).sort((a, b) => b.ownRevenueInr - a.ownRevenueInr)

  const employees = [...byPerson.values()].map(p => ({
    ...p,
    shareOfDeptPay: (pay.get(p.deptId) ?? 0) > 0 ? p.earningsInr / (pay.get(p.deptId) ?? 1) : 0,
  })).sort((a, b) => b.earningsInr - a.earningsInr)

  const sum = round2(departments.reduce((s, r) => s + r.resultInr, 0))
  return { departments, employees, sharedPoolInr: sharedPool, reconciliationInr: round2(sum - input.profitInr) }
}
