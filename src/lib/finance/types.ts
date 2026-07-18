/**
 * Finance Engine — shared types.
 *
 * The engine is the single source of truth for financial aggregation:
 * `journal.ts` is the only query surface, everything else is pure functions
 * over `JournalLine[]` (unit-testable, Supabase-free).
 */

import type { FinanceScope } from './classify'

export type StatementSection = 'revenue' | 'cogs' | 'opex' | 'financial' | 'excluded'

export const STATEMENT_SECTIONS: readonly StatementSection[] =
  ['revenue', 'cogs', 'opex', 'financial', 'excluded'] as const

export const SECTION_LABELS: Record<StatementSection | 'unclassified', string> = {
  revenue: 'Revenue',
  cogs: 'Direct Costs',
  opex: 'Operating Expenses',
  financial: 'Financial (non-P&L)',
  excluded: 'Excluded (drawings etc.)',
  unclassified: 'Unclassified',
}

/** One normalized money movement (from cashbook_entries + its category). */
export interface JournalLine {
  id: string
  /** entry_date, YYYY-MM-DD */
  date: string
  scope: FinanceScope | null            // null = untriaged
  section: StatementSection | null      // null = category unmapped
  accountCode: string | null            // e.g. 'opex.salaries'
  categoryId: string | null
  categoryName: string | null
  clientId: string | null
  employeeId: string | null
  bankAccountId: string | null
  /** Signed INR: inflow positive, outflow negative. */
  amountInr: number
  description: string | null
  isTransfer: boolean
  /** Tag names on this entry — only populated when fetched with includeTags. */
  tags?: string[]
}

/** One row of the "Spend by Tag" report. */
export interface TagSpendRow {
  tag: string
  totalInr: number
  entryCount: number
}

/** One row of the "Cost by Employee" report (money spent ON an employee —
 *  e.g. a shared software seat — not to be confused with contribution
 *  earnings, which is money EARNED BY an employee on client work). */
export interface EmployeeCostRow {
  employeeId: string
  employeeName: string
  employeeCqid: string
  totalInr: number
  itemCount: number
}

/** One P&L report line (an account) across months. */
export interface PnlAccountRow {
  accountCode: string                   // 'unclassified' bucket when unmapped
  section: StatementSection | 'unclassified'
  label: string                         // category name(s) behind the account
  /** month (YYYY-MM) → signed INR sum */
  byMonth: Record<string, number>
  totalInr: number
}

export interface PnlSectionBlock {
  section: StatementSection | 'unclassified'
  label: string
  rows: PnlAccountRow[]
  byMonth: Record<string, number>
  totalInr: number
}

export interface CompanyPnl {
  /** Ascending YYYY-MM keys covered by the report. */
  months: string[]
  sections: PnlSectionBlock[]
  /** revenue + cogs + opex (signed) per month — the operating result. */
  netByMonth: Record<string, number>
  netTotalInr: number
  /** Average monthly net operating outflow over the trailing window (positive number). */
  burnRateInr: number
  /** bankBalance ÷ burnRate; null when burn is zero/unknown. */
  runwayMonths: number | null
}

export interface ClientProfitabilityInput {
  clientId: string
  clientName: string
  invoicedInr: number
  collectedInr: number
  /** Rebilled expense originals + ad wallet campaign debits. */
  directCostsInr: number
  /** Σ contribution_scores.earnings_inr on this client's tasks. */
  attributedLaborInr: number
  /** Σ invoice_expense_items.markup_amount (INR) — margin on rebilling. */
  markupRevenueInr?: number
  /**
   * Delivered, never paid, written off. Already EXCLUDED from invoicedInr (see
   * lib/finance/invoice-revenue.ts) — reported so the loss is visible instead of
   * silently shrinking the margin.
   */
  badDebtInr?: number
  /**
   * Revenue given away. `invoicedInr` is already net of it, so this is a
   * disclosure, not a deduction — it answers "what did this client cost us in
   * concessions?", which a smaller revenue figure alone can never show.
   */
  discountInr?: number
}

export interface ClientProfitabilityRow extends ClientProfitabilityInput {
  markupRevenueInr: number
  badDebtInr: number
  discountInr: number
  /** invoiced − directCosts − attributedLabor + markup. */
  contributionMarginInr: number
  /** margin ÷ invoiced (0 when no revenue). */
  marginPct: number
}
