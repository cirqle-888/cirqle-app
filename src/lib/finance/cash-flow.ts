/**
 * Cash-flow totals over raw cash-book rows — "money in", "money out".
 *
 * The P&L reads the journal, which already drops transfers. These totals are
 * the OTHER kind of figure: the Cash Book header, the dashboard's Income /
 * Outflow cards and trend, the day headings. They sum cash-book rows
 * directly, and two kinds of row must not be read at face value there:
 *
 *   · an INTERNAL TRANSFER (`transfer_ref`) is one outflow and one inflow
 *     between the company's own accounts. Counted, it inflates both income
 *     and expense by the amount moved. It counts as neither.
 *
 *   · a REVERSAL (`reversal_of`) is the bank handing money back — a bounced
 *     salary NEFT returning, a refund going out. It is stored as the opposite
 *     type, so counted at face value a returned salary would show as new
 *     INCOME. It counts AGAINST the side of the entry it reverses: a returned
 *     ₹5,353 salary takes ₹5,353 off outflow, it adds nothing to inflow.
 *
 *   · a NON-OPERATING row — its category's statement section is `financial`
 *     (credit given to / returned by staff, loans, capital) or `excluded`
 *     (owner drawings, payouts) — moves money but is neither income nor
 *     spending, the same two sections the P&L drops. Use `operatingRows`
 *     before totalling; the row must carry `category.statement_section`.
 *
 * Balances are a different question and keep every row — a transfer does
 * move money between accounts, and a returned payment is back in the bank.
 *
 * Pure; shared by every screen that shows these figures so they cannot
 * drift apart again.
 */

export interface CashFlowRow {
  type: 'inflow' | 'outflow' | string
  amount_inr?: number | null
  transfer_ref?: string | null
  reversal_of?: string | null
}

/** A row with its category's statement section embedded. */
export interface SectionedRow {
  category?: { statement_section?: string | null } | null
}

export interface CashFlowTotals {
  inflow: number
  outflow: number
  net: number
}

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100

/**
 * What one row adds to the inflow and outflow totals. Either may be
 * negative (a reversal), and both are zero for a transfer.
 */
export function cashFlowContribution(row: CashFlowRow): { inflow: number; outflow: number } {
  if (row.transfer_ref) return { inflow: 0, outflow: 0 }
  const amount = Math.abs(Number(row.amount_inr) || 0)
  const isInflow = row.type === 'inflow'
  if (row.reversal_of) {
    // Opposite of its own type is the original's side.
    return isInflow ? { inflow: 0, outflow: -amount } : { inflow: -amount, outflow: 0 }
  }
  return isInflow ? { inflow: amount, outflow: 0 } : { inflow: 0, outflow: amount }
}

export function cashFlowTotals(rows: readonly CashFlowRow[]): CashFlowTotals {
  let inflow = 0
  let outflow = 0
  for (const r of rows) {
    const c = cashFlowContribution(r)
    inflow += c.inflow
    outflow += c.outflow
  }
  inflow = round2(inflow)
  outflow = round2(outflow)
  return { inflow, outflow, net: round2(inflow - outflow) }
}

/** True for credit, loan, capital, drawings and payout rows (see above). */
export function isNonOperating(row: SectionedRow): boolean {
  const section = row.category?.statement_section
  return section === 'financial' || section === 'excluded'
}

/** The rows that are income or spending; balances still need all of them. */
export function operatingRows<T extends SectionedRow>(rows: readonly T[]): T[] {
  return rows.filter(r => !isNonOperating(r))
}
