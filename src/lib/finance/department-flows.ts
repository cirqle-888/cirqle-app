/**
 * Dashboard — money and work by department (pure).
 *
 * A department is a service category, the same dimension the Department P&L
 * and Profit Sharing use: tasks, invoice lines and contribution earnings carry
 * it; cash-book rows and employees do not.
 *
 *   Job value   − actual    Σ task billing (same as the dashboard Job Value)
 *   Billed      − actual    invoice lines by department, scaled so each
 *                           invoice adds up to what it recognises as revenue
 *   Inflow      − actual    operating cash in, split over the lines of the
 *                           invoices it was allocated to; cash with no
 *                           invoice behind it stays Unassigned
 *   Outflow     − ESTIMATE  contribution pay is measured; every other rupee of
 *                           operating outflow is shared out by Billed share
 *                           (decided 2026-10-23: apportion by revenue)
 *
 * Built from day facts so the dashboard's date filter can slice it, and so
 * Σ inflow and Σ outflow equal the dashboard's own Income and Outflow cards
 * for the same window, to the paisa.
 */

import { splitByWeight } from '@/lib/reports/ownership-allocation'

export const UNASSIGNED_DEPT = '__unassigned__'

/** One department's activity on one day. Any field may be zero. */
export interface DeptDayFact {
  date: string
  deptId: string
  jobs: number
  jobValueInr: number
  billedInr: number
  inflowInr: number
  contributionPayInr: number
}

export interface DeptFlowRow {
  deptId: string
  jobs: number
  jobValueInr: number
  billedInr: number
  inflowInr: number
  contributionPayInr: number
  /** Apportioned — never present this as measured. */
  sharedCostInr: number
  outflowInr: number
  netInr: number
}

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100

/** splitByWeight for any sign: splits the magnitude and gives the sign back. */
function split(total: number, weights: number[]): number[] {
  const parts = splitByWeight(Math.abs(total), weights)
  return total < 0 ? parts.map(p => -p) : parts
}

/**
 * Totals per department for a window (null = every fact), with the window's
 * operating outflow shared out. `outflowInr` must be the dashboard's own
 * Outflow figure for the same window.
 */
export function departmentFlows(
  facts: readonly DeptDayFact[],
  window: { from: string; to: string } | null,
  outflowInr: number,
): DeptFlowRow[] {
  const by = new Map<string, DeptFlowRow>()
  for (const f of facts) {
    if (window && (f.date < window.from || f.date > window.to)) continue
    const row = by.get(f.deptId) ?? {
      deptId: f.deptId, jobs: 0, jobValueInr: 0, billedInr: 0, inflowInr: 0,
      contributionPayInr: 0, sharedCostInr: 0, outflowInr: 0, netInr: 0,
    }
    row.jobs += f.jobs
    row.jobValueInr += f.jobValueInr
    row.billedInr += f.billedInr
    row.inflowInr += f.inflowInr
    row.contributionPayInr += f.contributionPayInr
    by.set(f.deptId, row)
  }
  if (by.size === 0 && Math.abs(outflowInr) < 0.005) return []
  if (!by.has(UNASSIGNED_DEPT)) by.set(UNASSIGNED_DEPT, {
    deptId: UNASSIGNED_DEPT, jobs: 0, jobValueInr: 0, billedInr: 0, inflowInr: 0,
    contributionPayInr: 0, sharedCostInr: 0, outflowInr: 0, netInr: 0,
  })

  const rows = [...by.values()]
  const pay = r2(rows.reduce((s, r) => s + r.contributionPayInr, 0))
  const pool = r2(outflowInr - pay)
  // Share by Billed; a window with no invoices falls back to job value; with
  // neither, the whole pool is Unassigned.
  const billed = rows.map(r => Math.max(0, r.billedInr))
  const value = rows.map(r => Math.max(0, r.jobValueInr))
  const weights = billed.some(w => w > 0) ? billed
    : value.some(w => w > 0) ? value
    : rows.map(r => (r.deptId === UNASSIGNED_DEPT ? 1 : 0))
  const shares = split(pool, weights)

  return rows.map((r, i) => {
    const sharedCostInr = shares[i]
    const outflow = r2(r.contributionPayInr + sharedCostInr)
    const inflow = r2(r.inflowInr)
    return {
      ...r,
      jobValueInr: r2(r.jobValueInr),
      billedInr: r2(r.billedInr),
      inflowInr: inflow,
      contributionPayInr: r2(r.contributionPayInr),
      sharedCostInr,
      outflowInr: outflow,
      netInr: r2(inflow - outflow),
    }
  })
    .filter(r => r.deptId !== UNASSIGNED_DEPT || r.jobs || r.billedInr || r.inflowInr || r.outflowInr)
    .sort((a, b) => (a.deptId === UNASSIGNED_DEPT ? 1 : b.deptId === UNASSIGNED_DEPT ? -1 : b.billedInr - a.billedInr || b.jobValueInr - a.jobValueInr))
}

/**
 * Split one amount over an invoice's lines by department. Lines are weights
 * only (any currency); an invoice with no usable lines goes to Unassigned.
 */
export function splitOverLines(
  amountInr: number,
  lines: readonly { deptId: string | null; amount: number }[] | undefined,
): { deptId: string; amountInr: number }[] {
  const byDept = new Map<string, number>()
  for (const l of lines ?? []) {
    const k = l.deptId ?? UNASSIGNED_DEPT
    byDept.set(k, (byDept.get(k) ?? 0) + Math.max(0, Number(l.amount) || 0))
  }
  const depts = [...byDept.keys()].filter(k => (byDept.get(k) ?? 0) > 0)
  if (depts.length === 0) return [{ deptId: UNASSIGNED_DEPT, amountInr: r2(amountInr) }]
  const parts = split(amountInr, depts.map(d => byDept.get(d)!))
  return depts.map((deptId, i) => ({ deptId, amountInr: parts[i] }))
}
