/**
 * Finance Engine — employee cost attribution.
 *
 * COST attribution (money spent ON an employee — a shared laptop, a software
 * seat) is a distinct concept from LABOR attribution (`contribution_scores`:
 * money earned BY an employee on client work). This module reads the
 * `cashbook_entry_employee_splits` table (see splits.ts for the equal-split
 * math used when a shared expense is written).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { EmployeeCostRow } from './types'

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100

/**
 * Sections the ledger uses for money that is NOT spending — a loan out, an
 * owner's drawing. P&L drops exactly these two (pnl.ts), and a cost report
 * has the same reason to.
 */
export function isNotSpending(section: string | null | undefined): boolean {
  return section === 'financial' || section === 'excluded'
}

export interface EmployeeCostSplitRaw {
  employeeId: string
  employeeName: string
  employeeCqid: string
  amountInr: number
  entryId: string
  entryDate: string
  description: string | null
}

/**
 * Fetch raw employee cost-split rows in a date range. Tolerant of the
 * unapplied migration (20260714160000) — returns [] rather than throwing.
 */
export async function fetchEmployeeCostSplits(
  admin: SupabaseClient,
  filter: { from?: string; to?: string } = {},
): Promise<EmployeeCostSplitRaw[]> {
  const { data, error } = await admin
    .from('cashbook_entry_employee_splits')
    .select(`
      amount_inr,
      employee:employees(id, name, cqid),
      entry:cashbook_entries(
        id, entry_date, description, deleted_at,
        category:cashbook_categories(statement_section)
      )
    `)
  if (error) return []   // table not migrated yet, or transient — degrade quietly

  // An expense the bank returned was not spent on anybody. Reversals carry no
  // split of their own, so the original is simply left out. (Before migration
  // 20261016100000 the column is missing, the query errors, and nothing is.)
  const { data: revRows, error: revErr } = await admin
    .from('cashbook_entries').select('reversal_of')
    .not('reversal_of', 'is', null).is('deleted_at', null)
  const reversed = new Set<string>(revErr ? [] : (revRows || []).map((r: any) => r.reversal_of as string))

  return (data || [])
    .filter((r: any) => r.entry && !r.entry.deleted_at && r.employee?.id)
    .filter((r: any) => !reversed.has(r.entry.id))
    // A COST is money spent ON somebody. An advance is money lent TO them:
    // it is not spent, it comes back, and the `financial` and `excluded`
    // sections are exactly where the ledger keeps things that are not
    // spending — the same two P&L drops (see pnl.ts).
    //
    // Without this a ₹50,000 credit given to CQID001 was reported as
    // ₹50,000 of cost attributed to them, next to ₹7,863 of real cost. The
    // split is still the right record of WHO took the money; it belongs in
    // the credit ledger (credit-ledger.ts), not in what they cost.
    .filter((r: any) => !isNotSpending(r.entry.category?.statement_section))
    .filter((r: any) => !filter.from || r.entry.entry_date >= filter.from)
    .filter((r: any) => !filter.to || r.entry.entry_date <= filter.to)
    .map((r: any) => ({
      employeeId: r.employee.id as string,
      employeeName: (r.employee.name as string) || 'Unknown',
      employeeCqid: (r.employee.cqid as string) || '—',
      amountInr: Number(r.amount_inr || 0),
      entryId: r.entry.id as string,
      entryDate: r.entry.entry_date as string,
      description: (r.entry.description as string) ?? null,
    }))
}

/** Pure: aggregate raw splits into a per-employee cost report, sorted by total desc. */
export function buildEmployeeCostReport(rows: EmployeeCostSplitRaw[]): EmployeeCostRow[] {
  const byEmployee = new Map<string, EmployeeCostRow>()
  for (const r of rows) {
    let row = byEmployee.get(r.employeeId)
    if (!row) {
      row = { employeeId: r.employeeId, employeeName: r.employeeName, employeeCqid: r.employeeCqid, totalInr: 0, itemCount: 0 }
      byEmployee.set(r.employeeId, row)
    }
    row.totalInr = round2(row.totalInr + r.amountInr)
    row.itemCount += 1
  }
  return [...byEmployee.values()].sort((a, b) => b.totalInr - a.totalInr)
}
