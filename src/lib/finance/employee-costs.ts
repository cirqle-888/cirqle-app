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

export interface EmployeeCostSplitRaw {
  employeeId: string
  employeeName: string
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
      employee:employees(id, name),
      entry:cashbook_entries(id, entry_date, description, deleted_at)
    `)
  if (error) return []   // table not migrated yet, or transient — degrade quietly

  return (data || [])
    .filter((r: any) => r.entry && !r.entry.deleted_at && r.employee?.id)
    .filter((r: any) => !filter.from || r.entry.entry_date >= filter.from)
    .filter((r: any) => !filter.to || r.entry.entry_date <= filter.to)
    .map((r: any) => ({
      employeeId: r.employee.id as string,
      employeeName: (r.employee.name as string) || 'Unknown',
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
      row = { employeeId: r.employeeId, employeeName: r.employeeName, totalInr: 0, itemCount: 0 }
      byEmployee.set(r.employeeId, row)
    }
    row.totalInr = round2(row.totalInr + r.amountInr)
    row.itemCount += 1
  }
  return [...byEmployee.values()].sort((a, b) => b.totalInr - a.totalInr)
}
