/**
 * Profit Sharing — shared types.
 *
 * Design: docs/PROFIT-SHARING-DESIGN.md. Everything in this folder except
 * load.ts is pure: plain data in, plain data out, so every rule in the design
 * is pinned by a vitest test rather than inferred from a database.
 *
 * Money is INR, rounded to the paisa with round2 from calculations/currency.
 * Dates are YYYY-MM-DD strings, compared as strings.
 */

export type Section = 'revenue' | 'cogs' | 'opex' | 'financial' | 'excluded'

/** One Cash Book entry, normalised. `amountInr` is a positive magnitude. */
export interface LedgerEntry {
  id: string
  date: string
  type: 'inflow' | 'outflow'
  amountInr: number
  categoryId: string | null
  categoryName: string | null
  section: Section | null
  accountCode: string | null
  clientId: string | null
  employeeId: string | null
  invoiceId: string | null
  bankAccountId: string | null
  transferRef: string | null
  /** Set on a reversal: the entry whose money went back (migration 20261016100000). */
  reversalOf: string | null
  isBillable: boolean
  reference: string | null
}

/** A Cash Book receipt applied to an invoice. Released allocations are kept:
 *  the reversal that released them undoes their effect on its own date. */
export interface InvoiceAllocation {
  entryId: string
  invoiceId: string
  amountInr: number
  /** Date the allocation was made. */
  allocatedOn: string
}

/** What an invoice is made of, in INR (design §3.4). */
export interface InvoiceRaw {
  id: string
  clientId: string | null
  status: string
  exchangeRate: number
  totalAmount: number
  totalAmountInr: number | null
  taxAmount: number
  discountAmount: number
  previousBalance: number
  updatedOn: string | null
  /** Σ invoice_items.total, invoice currency. */
  itemsTotal: number
  /** Σ invoice_expense_items.markup_amount, invoice currency. */
  markupTotal: number
  /** Σ invoice_ad_spend_items.amount_inr. */
  adSpendInr: number
  /** Σ invoice_expense_items.original_amount_inr. */
  expenseOriginalInr: number
}

export interface Composition {
  ownInr: number
  passInr: number
  taxInr: number
  carriedInr: number
  totalInr: number
}

/** A client wallet top-up share of a Cash Book outflow (`ad_wallet_ledger` credit). */
export interface WalletCredit {
  entryId: string
  /** null = Cirqle's own (company) wallet. */
  clientId: string | null
  amountInr: number
}

export interface PayrollRow {
  id: string
  employeeId: string | null
  month: number
  year: number
  base: number
  commission: number
  bonus: number
  adjustment: number
  ownership: number
  advancesDeducted: number
  otherDeductions: number
  storedNet: number | null
  status: string | null
}

export interface PayrollAllocation {
  entryId: string
  payrollId: string
  amountInr: number
}

export type CreditType = 'given' | 'returned' | 'converted_drawings' | 'converted_salary'

export interface CreditRow {
  id: string
  type: CreditType
  employeeId: string | null
  amountInr: number
  date: string
}

/** An admin classification of a source row. The source itself is never edited. */
export interface Review {
  id: string
  sourceTable: string
  sourceId: string
  category: ReviewCategory
  classification: string
  memberId: string | null
  amountInr: number | null
  reviewedOn: string
  detail: Record<string, unknown> | null
}

export type ReviewCategory =
  | 'personal_withdrawal'
  | 'unidentified_receipt'
  | 'chargeback'
  | 'salary_without_payroll'
  | 'advance_deduction'
  | 'credit_conversion'
  | 'invoice_split'
  | 'unassigned_ad_funding'

export interface CashLink {
  entryId: string
  ownerKind: 'capital' | 'settlement'
  ownerId: string
}

/** What a settlement-linked Cash Book entry pays for. */
export interface SettlementRef {
  id: string
  kind: 'paid' | 'reinvested' | 'waived' | 'advance_offset'
  entitlementId: string | null
  deviceValuationId: string | null
  /** For device settlements: usage costs are pre-recognised; purchases are not. */
  deviceKind: 'usage' | 'transfer' | null
  amountInr: number
}

/** A confirmed device usage valuation — a cost recognised when confirmed (D14). */
export interface DeviceCost {
  valuationId: string
  confirmedOn: string
  amountInr: number
}

export interface CapitalMovement {
  id: string
  memberId: string
  direction: 'in' | 'out'
  amountInr: number
  weight: number
  effectiveOn: string
  status: 'pending_approval' | 'approved' | 'rejected'
}

export interface Settings {
  id: string | null
  distributionPct: number
  capitalSharePct: number
  reservePct: number
  toleranceInr: number
  adPrepaidBlockDays: number
  passthroughWarnDays: number
}

export const DEFAULT_SETTINGS: Settings = {
  id: null,
  distributionPct: 50,
  capitalSharePct: 50,
  reservePct: 50,
  toleranceInr: 1,
  adPrepaidBlockDays: 60,
  passthroughWarnDays: 90,
}

export type GateLevel = 'block' | 'warn'

export interface Gate {
  key: string
  level: GateLevel
  message: string
  count?: number
  amountInr?: number
}

/** Something an admin must classify before the period can be confirmed. */
export interface ReviewItem {
  category: ReviewCategory
  sourceTable: string
  sourceId: string
  date: string
  amountInr: number
  reason: string
  /** Extra context for the review form (client, employee, invoice …). */
  context?: Record<string, unknown>
}
