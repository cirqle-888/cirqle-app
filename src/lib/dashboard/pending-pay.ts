import { round2 } from '@/lib/calculations/currency'

/** One unpaid payslip. `month` is the work month (1-12) the payslip covers. */
export interface PendingSlip {
  month: number
  year: number
  payslipNumber: string | null
  netInr: number
  commissionInr: number
  ownershipInr: number
  otherInr: number
}

export interface PendingPay {
  slips: PendingSlip[]
  /** Σ net of the slips. */
  slipsTotalInr: number
  /** Payslips worth nothing — left open, but owed nothing. */
  zeroSlips: number
}

export interface PayrollRow {
  employee_id: string
  month: number
  year: number
  payslip_number?: string | null
  net_salary?: number | null
  commission_earned?: number | null
  ownership_earned?: number | null
  adjustment_earned?: number | null
  bonus?: number | null
  base_salary?: number | null
}

/**
 * What the company still owes each person on payslips already generated:
 * every payroll row whose status is still `pending`, oldest first. Rows worth
 * ₹0 are counted but not listed — they owe nothing, they just were never
 * marked paid.
 */
export function pendingPayByEmployee(rows: readonly PayrollRow[]): Record<string, PendingPay> {
  const out: Record<string, PendingPay> = {}
  const sorted = [...rows].sort((a, b) => a.year - b.year || a.month - b.month)
  for (const r of sorted) {
    const e = (out[r.employee_id] ??= { slips: [], slipsTotalInr: 0, zeroSlips: 0 })
    const net = round2(Number(r.net_salary) || 0)
    if (net <= 0) { e.zeroSlips += 1; continue }
    const commission = round2(Number(r.commission_earned) || 0)
    const ownership = round2(Number(r.ownership_earned) || 0)
    e.slips.push({
      month: r.month, year: r.year, payslipNumber: r.payslip_number ?? null, netInr: net,
      commissionInr: commission, ownershipInr: ownership, otherInr: round2(net - commission - ownership),
    })
    e.slipsTotalInr = round2(e.slipsTotalInr + net)
  }
  return out
}
