/**
 * Remuneration for profit sharing (design §6, D5 confirmed).
 *
 *   Gross earned  G = base + commission + bonus + adjustment + ownership
 *   Net payable   N = max(0, G − advances deducted − other deductions)
 *   Liability       = N − salary paid (Σ live payslip allocations)
 *
 * Remuneration is recognised in the payroll month it is earned, from its
 * components — never from stored net_salary, which two recalc paths compute
 * without the bonus (payroll/actions.ts). Salary Cash Book payments settle the
 * liability and are never an expense here, so pay is counted exactly once.
 *
 * Advances are where pay gets counted twice: a deduction typed into payroll is
 * never written to the credit ledger, so the same advance can also be
 * "converted to salary". Both cases go to review (D5) and block confirmation
 * until an Admin links or classifies them.
 *
 * `other_deductions` has no confirmed meaning (D17): it affects net pay and
 * nothing else here, and every period that has some shows a warning.
 */

import { round2 } from '@/lib/calculations/currency'
import type { CreditRow, PayrollRow, Review, ReviewItem } from './types'
import { reviewKey } from './classify'

export const grossOf = (r: PayrollRow) =>
  round2(r.base + r.commission + r.bonus + r.adjustment + r.ownership)

export const netOf = (r: PayrollRow) =>
  round2(Math.max(0, grossOf(r) - r.advancesDeducted - r.otherDeductions))

/** How much of the deducted advance pay could actually absorb (the net clamp). */
export const advanceRecoveredOf = (r: PayrollRow) =>
  round2(Math.min(r.advancesDeducted, Math.max(0, grossOf(r) - r.otherDeductions)))

/** YYYY-MM-01 of a payroll row's month. */
export const monthStart = (r: { month: number; year: number }) =>
  `${r.year}-${String(r.month).padStart(2, '0')}-01`

export interface PayrollSummary {
  /** Σ gross for the months in the period. */
  grossEarnedInr: number
  /** Conversions classified as additional pay. */
  conversionPayInr: number
  remunerationInr: number
  /** At period end, across every payroll month up to it. */
  liabilityInr: number
  overpaidInr: number
  otherDeductionsInr: number
  rows: { id: string; month: string; gross: number; net: number; paid: number; storedNetDiffers: boolean }[]
  reviewItems: ReviewItem[]
  warnings: { key: string; message: string; amountInr?: number; count?: number }[]
  monthsWithoutPayroll: string[]
}

export function summarisePayroll(input: {
  rows: PayrollRow[]
  /** payroll id → Σ salary paid (live allocations + reviewed settlements). */
  paidByPayroll: Map<string, number>
  credits: CreditRow[]
  reviews: Map<string, Review>
  /** Period months as YYYY-MM-01. */
  months: string[]
  start: string
  end: string
}): PayrollSummary {
  const inPeriod = (r: PayrollRow) => input.months.includes(monthStart(r))
  const upToEnd = (r: PayrollRow) => monthStart(r) <= input.end

  let gross = 0
  let liability = 0
  let overpaid = 0
  let otherDeductions = 0
  const rows: PayrollSummary['rows'] = []
  const reviewItems: ReviewItem[] = []
  const warnings: PayrollSummary['warnings'] = []
  let netMismatch = 0

  for (const r of input.rows) {
    if (!upToEnd(r)) continue
    const g = grossOf(r)
    const n = netOf(r)
    const paid = round2(input.paidByPayroll.get(r.id) ?? 0)
    const owed = round2(n - paid)
    if (owed >= 0) liability += owed
    else overpaid += -owed
    if (!inPeriod(r)) continue

    gross += g
    otherDeductions += r.otherDeductions
    const storedNetDiffers = r.storedNet != null && Math.abs(r.storedNet - n) > 1
    if (storedNetDiffers) netMismatch++
    rows.push({ id: r.id, month: monthStart(r), gross: g, net: n, paid, storedNetDiffers })

    if (r.advancesDeducted > 0 && !input.reviews.has(reviewKey('payroll', r.id))) {
      reviewItems.push({
        category: 'advance_deduction', sourceTable: 'payroll', sourceId: r.id,
        date: monthStart(r), amountInr: r.advancesDeducted,
        reason: 'Advance deducted in payroll: link it to the credit-ledger advance it recovers',
        context: { employeeId: r.employeeId, recovered: advanceRecoveredOf(r) },
      })
    }
  }

  let conversionPay = 0
  for (const c of input.credits) {
    if (c.type !== 'converted_salary' || c.date < input.start || c.date > input.end) continue
    const r = input.reviews.get(reviewKey('credit_ledger', c.id))
    if (!r) {
      reviewItems.push({
        category: 'credit_conversion', sourceTable: 'credit_ledger', sourceId: c.id,
        date: c.date, amountInr: c.amountInr,
        reason: 'Advance converted to salary: is it additional pay, or the record of a payroll deduction?',
        context: { employeeId: c.employeeId },
      })
    } else if (r.classification === 'additional_pay') {
      conversionPay += c.amountInr
    }
  }

  if (otherDeductions > 0) {
    warnings.push({
      key: 'other_deductions',
      message: 'Payroll “other deductions” have no confirmed meaning yet (D17). Pay is counted in full; '
        + 'if these are tax withheld, cash available is overstated by this amount.',
      amountInr: round2(otherDeductions),
    })
  }
  if (netMismatch > 0) {
    warnings.push({
      key: 'stored_net',
      message: 'Stored net salary differs from the components on some payslips; the components are used.',
      count: netMismatch,
    })
  }
  if (overpaid > 0) {
    warnings.push({ key: 'overpaid', message: 'Some payslips are paid more than their net pay.', amountInr: round2(overpaid) })
  }

  const monthsWithoutPayroll = input.months.filter(m => !input.rows.some(r => monthStart(r) === m))

  const grossEarnedInr = round2(gross)
  const conversionPayInr = round2(conversionPay)
  return {
    grossEarnedInr,
    conversionPayInr,
    remunerationInr: round2(grossEarnedInr + conversionPayInr),
    liabilityInr: round2(liability),
    overpaidInr: round2(overpaid),
    otherDeductionsInr: round2(otherDeductions),
    rows,
    reviewItems,
    warnings,
    monthsWithoutPayroll,
  }
}
