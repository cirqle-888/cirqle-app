/**
 * Finance Engine — P&L aggregation (pure).
 *
 * Company P&L = company-scoped journal lines grouped month × account, with
 * section subtotals and the operating result. Cash-basis by construction
 * (the cashbook is the ledger). `financial` and `excluded` sections never
 * enter the P&L; transfers are already filtered by the journal.
 */

import type {
  CompanyPnl, JournalLine, PnlAccountRow, PnlSectionBlock, StatementSection,
} from './types'
import { SECTION_LABELS } from './types'

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100

/** YYYY-MM of a YYYY-MM-DD date string. */
export const monthOf = (date: string): string => date.slice(0, 7)

const PNL_SECTIONS: readonly (StatementSection | 'unclassified')[] =
  ['revenue', 'cogs', 'opex', 'unclassified'] as const

/** Ascending list of YYYY-MM keys between two months, inclusive. */
export function monthRange(fromMonth: string, toMonth: string): string[] {
  const out: string[] = []
  let [y, m] = fromMonth.split('-').map(Number)
  const [ty, tm] = toMonth.split('-').map(Number)
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}

export interface BuildPnlOptions {
  /** Restrict to these months (ascending YYYY-MM). Default: months seen in data. */
  months?: string[]
  /** For runway: current bank balance (all accounts), INR. */
  bankBalanceInr?: number | null
  /** Trailing months used for the burn-rate average (default 3). */
  burnWindow?: number
}

/**
 * Build the company P&L from journal lines. Pass ONLY the lines you want on
 * the statement (typically `scope === 'company'`); the function additionally
 * drops `financial`/`excluded` sections so callers can't accidentally count
 * owner drawings as expenses.
 */
export function buildCompanyPnl(lines: JournalLine[], opts: BuildPnlOptions = {}): CompanyPnl {
  const usable = lines.filter(l =>
    l.section !== 'financial' && l.section !== 'excluded' && !l.isTransfer)

  const monthsSeen = new Set<string>()
  for (const l of usable) monthsSeen.add(monthOf(l.date))
  const months = opts.months ?? [...monthsSeen].sort()
  const monthSet = new Set(months)

  // account → row
  const rowMap = new Map<string, PnlAccountRow>()
  for (const l of usable) {
    const m = monthOf(l.date)
    if (!monthSet.has(m)) continue
    const section: StatementSection | 'unclassified' =
      (l.section as StatementSection | null) ?? 'unclassified'
    const account = l.accountCode ?? `unclassified.${l.categoryName ?? 'uncategorised'}`
    let row = rowMap.get(account)
    if (!row) {
      row = { accountCode: account, section, label: l.categoryName ?? account, byMonth: {}, totalInr: 0 }
      rowMap.set(account, row)
    }
    row.byMonth[m] = round2((row.byMonth[m] ?? 0) + l.amountInr)
    row.totalInr = round2(row.totalInr + l.amountInr)
  }

  const sections: PnlSectionBlock[] = []
  for (const section of PNL_SECTIONS) {
    const rows = [...rowMap.values()]
      .filter(r => r.section === section)
      .sort((a, b) => Math.abs(b.totalInr) - Math.abs(a.totalInr))
    if (rows.length === 0) continue
    const byMonth: Record<string, number> = {}
    let totalInr = 0
    for (const r of rows) {
      totalInr = round2(totalInr + r.totalInr)
      for (const [m, v] of Object.entries(r.byMonth)) byMonth[m] = round2((byMonth[m] ?? 0) + v)
    }
    sections.push({ section, label: SECTION_LABELS[section], rows, byMonth, totalInr })
  }

  const netByMonth: Record<string, number> = {}
  for (const m of months) {
    netByMonth[m] = round2(sections.reduce((s, sec) => s + (sec.byMonth[m] ?? 0), 0))
  }
  const netTotalInr = round2(Object.values(netByMonth).reduce((s, v) => s + v, 0))

  // Burn rate: average net operating OUTFLOW over the trailing window
  // (months with a net inflow contribute 0 — they don't "un-burn").
  const window = Math.max(1, opts.burnWindow ?? 3)
  const trailing = months.slice(-window)
  const burnRateInr = trailing.length === 0 ? 0 : round2(
    trailing.reduce((s, m) => s + Math.max(0, -(netByMonth[m] ?? 0)), 0) / trailing.length,
  )

  const bank = opts.bankBalanceInr
  const runwayMonths = burnRateInr > 0 && bank != null && bank >= 0
    ? Math.round((bank / burnRateInr) * 10) / 10
    : null

  return { months, sections, netByMonth, netTotalInr, burnRateInr, runwayMonths }
}
