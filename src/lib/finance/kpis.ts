/**
 * Finance Engine — dashboard KPI computations (pure).
 */

import type { JournalLine } from './types'
import { buildCompanyPnl, monthOf } from './pnl'

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100

export interface CompanyOpsStrip {
  /** YYYY-MM the strip describes. */
  month: string
  /** Total company operating spend this month (positive INR). */
  opexInr: number
  /** Of which salaries (opex.salaries). */
  payrollInr: number
  /** Of which marketing (opex.marketing — includes internal ad spend, GST-inclusive). */
  marketingInr: number
  /** Of which software subscriptions (opex.software). */
  softwareInr: number
  /** Avg monthly net operating outflow, trailing 3 months (positive INR). */
  burnRateInr: number
  /** bankBalance ÷ burn; null when burn is 0 or balance unknown. */
  runwayMonths: number | null
  /** Count of cashbook entries still needing scope triage. */
  untriagedCount: number
}

/**
 * Compute the dashboard "Company Ops" strip.
 * `lines` should span at least the trailing burn window (pass ~4 months);
 * scope filtering happens here — pass all scopes so untriaged can be counted.
 */
export function computeCompanyOpsStrip(
  lines: JournalLine[],
  opts: { month: string; bankBalanceInr?: number | null },
): CompanyOpsStrip {
  const company = lines.filter(l => l.scope === 'company')
  const pnl = buildCompanyPnl(company, { bankBalanceInr: opts.bankBalanceInr })

  const inMonth = company.filter(l =>
    monthOf(l.date) === opts.month &&
    l.section !== 'financial' && l.section !== 'excluded')

  const spend = (pred: (l: JournalLine) => boolean) =>
    round2(inMonth.filter(pred).reduce((s, l) => s + Math.max(0, -l.amountInr), 0))

  return {
    month: opts.month,
    opexInr: spend(() => true),
    payrollInr: spend(l => l.accountCode === 'opex.salaries'),
    marketingInr: spend(l => l.accountCode === 'opex.marketing'),
    softwareInr: spend(l => l.accountCode === 'opex.software'),
    burnRateInr: pnl.burnRateInr,
    runwayMonths: pnl.runwayMonths,
    untriagedCount: lines.filter(l => l.scope == null && !l.isTransfer).length,
  }
}
