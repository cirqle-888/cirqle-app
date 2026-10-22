/**
 * Every Cash Book entry lands in exactly one place (design §3.3).
 *
 * Two layers, kept apart on purpose:
 *
 *   CASH — what moved, on the entry date. Each entry splits into one or more
 *     parts whose amounts add up to the entry exactly, so Σ parts over a
 *     period === closing − opening by construction. That identity is the cash
 *     bridge.
 *   RECOGNITION — what counts for profit, on its own date. A client receipt is
 *     cash on the day it arrives but becomes Cirqle's revenue only when it is
 *     allocated to an invoice and its composition is known (D3), and then only
 *     its own-revenue share (D2).
 *
 * An entry the rules cannot place goes to `needs_review`, which blocks
 * confirmation until an Admin classifies it. Nothing is guessed.
 */

import { round2 } from '@/lib/calculations/currency'
import { splitAllocations, type AllocationSplit } from './composition'
import type {
  CashLink, Composition, InvoiceAllocation, LedgerEntry, Review, ReviewCategory, ReviewItem,
  SettlementRef, WalletCredit,
} from './types'

export type CashBucket =
  | 'client_receipts'      // revenue-section receipts from clients / applied to invoices
  | 'own_revenue_direct'   // reviewed: Cirqle revenue with no invoice
  | 'passthrough_paid'     // paid on a client's behalf (wallet share, rebilled cost)
  | 'ad_prepaid'           // ad-platform funding not yet shared to any wallet (D4)
  | 'operating'            // Cirqle's own operating payments (and refunds of them)
  | 'salary_paid'          // settles payroll — never an expense here (D5)
  | 'extra_pay'            // reviewed: pay outside payroll
  | 'advance'              // reviewed: really an advance to an employee
  | 'capital'
  | 'loan'
  | 'credit'               // credit given / returned
  | 'transfer'
  | 'payout'               // profit-share payout (settlement-linked)
  | 'device_settlement'    // pays a device usage cost recognised at confirmation (D14)
  | 'drawing'
  | 'financial_other'
  | 'needs_review'
  | 'unclassified'

export const BUCKET_LABELS: Record<CashBucket, string> = {
  client_receipts: 'Client receipts',
  own_revenue_direct: 'Own revenue without an invoice (reviewed)',
  passthrough_paid: 'Paid on clients’ behalf (pass-through)',
  ad_prepaid: 'Ad-platform funding not yet assigned (prepaid)',
  operating: 'Own operating payments',
  salary_paid: 'Salaries paid (settles payroll)',
  extra_pay: 'Pay outside payroll (reviewed)',
  advance: 'Advances to employees (reviewed)',
  capital: 'Capital in / out',
  loan: 'Loans',
  credit: 'Credit given / returned',
  transfer: 'Transfers between own accounts',
  payout: 'Profit-share payouts',
  device_settlement: 'Device usage settlements',
  drawing: 'Drawings',
  financial_other: 'Other non-operating',
  needs_review: 'Needs review',
  unclassified: 'Unclassified',
}

export interface CashPart {
  bucket: CashBucket
  /** Signed cash: inflow +, outflow −. */
  cashInr: number
}

export interface ClassifiedEntry {
  entry: LedgerEntry
  parts: CashPart[]
  /** Why it needs review (or which invoice split it is waiting on). */
  review?: { category: ReviewCategory; sourceTable: string; sourceId: string; reason: string }
  /** Capital or payout entries that should be linked to a module record but are not. */
  unlinked?: 'capital' | 'payout' | 'capital_withdrawal'
}

export interface RecognitionEvent {
  date: string
  kind: 'own_revenue' | 'pass_recovered' | 'tax_collected' | 'excess_held' | 'operating'
    | 'extra_pay' | 'ad_written_off'
  amountInr: number
  source: string
  /** Derived from a client receipt applied to an invoice (or its reversal). */
  fromReceipt?: boolean
}

export interface ClassifyInput {
  entries: LedgerEntry[]
  allocations: InvoiceAllocation[]
  /** Composition to use per invoice (derived, or from a review). Missing = not splittable yet. */
  compositions: Map<string, Composition>
  /** Invoices whose composition needs an Admin split, with the reason. */
  invoicesNeedingReview: Map<string, string>
  walletCredits: WalletCredit[]
  /** Cash Book entries rebilled on an invoice (invoice_expense_items.cashbook_entry_id). */
  rebilledEntryIds: Set<string>
  /** Cash Book entries allocated to a payroll row. */
  payrollAllocatedEntryIds: Set<string>
  reviews: Map<string, Review>
  cashLinks: Map<string, CashLink>
  settlements: Map<string, SettlementRef>
}

export const reviewKey = (table: string, id: string) => `${table}:${id}`

const AD_FUNDING_CODE = 'cogs.ad_spend'
const SALARY_CODE = 'opex.salaries'
const DRAWINGS_CODE = 'excluded.owner_drawings'

export interface ClassifyResult {
  classified: ClassifiedEntry[]
  splits: AllocationSplit[]
  recognition: RecognitionEvent[]
}

/** Classify every entry (all history up to the period end — balances need it). */
export function classifyEntries(input: ClassifyInput): ClassifyResult {
  const byId = new Map(input.entries.map(e => [e.id, e]))
  const creditsByEntry = new Map<string, WalletCredit[]>()
  for (const c of input.walletCredits) {
    const list = creditsByEntry.get(c.entryId) ?? []
    list.push(c)
    creditsByEntry.set(c.entryId, list)
  }
  const allocatedEntryIds = new Set(input.allocations.map(a => a.entryId))

  const entryDates = new Map(input.entries.map(e => [e.id, e.date]))
  const splittable = input.allocations.filter(a => input.compositions.has(a.invoiceId))
  const splits = splitAllocations(splittable, entryDates, input.compositions)
  const splitsByEntry = new Map<string, AllocationSplit[]>()
  for (const s of splits) {
    const list = splitsByEntry.get(s.entryId) ?? []
    list.push(s)
    splitsByEntry.set(s.entryId, list)
  }

  const recognition: RecognitionEvent[] = []
  const pushSplit = (s: AllocationSplit, date: string, factor: number, source: string) => {
    const ev = (kind: RecognitionEvent['kind'], v: number) =>
      recognition.push({ date, kind, amountInr: round2(v * factor), source, fromReceipt: true })
    if (s.passInr) ev('pass_recovered', s.passInr)
    if (s.taxInr) ev('tax_collected', s.taxInr)
    if (s.ownInr) ev('own_revenue', s.ownInr)
    if (s.excessInr) ev('excess_held', s.excessInr)
  }
  for (const s of splits) pushSplit(s, s.recognisedOn, 1, s.entryId)

  const memo = new Map<string, ClassifiedEntry>()

  const classifyOne = (e: LedgerEntry): ClassifiedEntry => {
    const hit = memo.get(e.id)
    if (hit) return hit
    const result = classifyFresh(e)
    memo.set(e.id, result)
    return result
  }

  const classifyFresh = (e: LedgerEntry): ClassifiedEntry => {
    const cashInr = round2(e.type === 'inflow' ? e.amountInr : -e.amountInr)
    const one = (bucket: CashBucket, extra: Partial<ClassifiedEntry> = {}): ClassifiedEntry =>
      ({ entry: e, parts: [{ bucket, cashInr }], ...extra })
    const reviewed = (id = e.id) => input.reviews.get(reviewKey('cashbook_entries', id))
    const needs = (category: ReviewCategory, reason: string): ClassifiedEntry =>
      one('needs_review', { review: { category, sourceTable: 'cashbook_entries', sourceId: e.id, reason } })

    // 1. Module links win: the module knows exactly what this money was.
    const link = input.cashLinks.get(e.id)
    if (link?.ownerKind === 'capital') return one('capital')
    if (link?.ownerKind === 'settlement') {
      const s = input.settlements.get(link.ownerId)
      if (s?.entitlementId) return one('payout')
      // A purchase (transfer valuation) is an ordinary expense when paid; a
      // usage cost was already recognised at confirmation (D14).
      if (s?.deviceKind === 'transfer') return one('operating')
      return one('device_settlement')
    }

    // 2. Own-account transfers net to zero across the books.
    if (e.transferRef) return one('transfer')

    // 3. A reversal takes the class of what it reverses, scaled and negated.
    if (e.reversalOf) {
      const original = byId.get(e.reversalOf)
      if (!original || original.amountInr <= 0) return needs('chargeback', 'Reversal of an entry that is not in the books')
      const o = classifyOne(original)
      const factor = -(e.amountInr / original.amountInr)
      const parts = scaleParts(o.parts, factor, cashInr)
      if (o.parts.some(p => p.bucket === 'client_receipts')) {
        for (const s of splitsByEntry.get(original.id) ?? []) pushSplit(s, e.date, factor, e.id)
      }
      return { entry: e, parts, review: o.review }
    }

    // 4. Money allocated to a payslip settles payroll, whatever its category.
    if (e.type === 'outflow' && input.payrollAllocatedEntryIds.has(e.id)) return one('salary_paid')

    switch (e.section) {
      case 'revenue': {
        if (e.type === 'outflow') {
          const r = reviewed()
          if (!r) return needs('chargeback', 'Money out of a revenue category without a reversal link')
          if (r.classification === 'reduce_own_revenue') return one('own_revenue_direct')
          if (r.classification === 'refund_client_funds') return one('client_receipts')
          return one('financial_other')
        }
        if (allocatedEntryIds.has(e.id) || e.clientId) return one('client_receipts')
        const r = reviewed()
        if (!r) return needs('unidentified_receipt', 'Revenue-category receipt with no client and no invoice')
        switch (r.classification) {
          case 'own_revenue': return one('own_revenue_direct')
          case 'client_funds': return one('client_receipts')
          case 'capital': return one('capital', { unlinked: 'capital' })
          case 'loan': return one('loan')
          default: return one('financial_other')
        }
      }

      case 'cogs':
      case 'opex': {
        const credits = creditsByEntry.get(e.id)
        if (e.type === 'outflow' && (credits?.length || e.accountCode === AD_FUNDING_CODE)) {
          return { entry: e, parts: adFundingParts(e.amountInr, credits ?? []) }
        }
        if (e.type === 'outflow' && (input.rebilledEntryIds.has(e.id) || (e.isBillable && e.clientId))) {
          return one('passthrough_paid')
        }
        if (e.accountCode === SALARY_CODE && e.type === 'outflow') {
          if ((e.reference ?? '').startsWith('payroll:')) return one('salary_paid')
          if (e.employeeId) {
            const r = reviewed()
            if (!r) return needs('salary_without_payroll', 'Salary paid to an employee with no payslip allocation')
            if (r.classification === 'payroll_settlement') return one('salary_paid')
            if (r.classification === 'extra_pay') return one('extra_pay')
            return one('advance')
          }
        }
        return one('operating')
      }

      case 'financial': {
        if (e.accountCode === 'financial.credit_given' || e.accountCode === 'financial.credit_return') return one('credit')
        if (e.accountCode === 'financial.capital_introduced') return one('capital', { unlinked: 'capital' })
        if (e.accountCode?.startsWith('financial.loan')) return one('loan')
        return one('financial_other')
      }

      case 'excluded': {
        if (e.accountCode === DRAWINGS_CODE) {
          const r = reviewed()
          if (!r) return needs('personal_withdrawal', 'Personal Withdrawal not yet reviewed')
          switch (r.classification) {
            case 'capital_withdrawal': return one('capital')
            case 'reimbursement': return one('operating')
            case 'loan_to_member': return one('credit')
            default: return one('drawing')
          }
        }
        if (e.accountCode === 'excluded.profit_distribution') return one('payout', { unlinked: 'payout' })
        if (e.accountCode === 'excluded.capital_withdrawal') return one('capital', { unlinked: 'capital_withdrawal' })
        return one('drawing')
      }

      default:
        return one('unclassified')
    }
  }

  const classified = input.entries.map(classifyOne)
  const classifiedById = new Map(classified.map(c => [c.entry.id, c]))

  // Receipts applied to invoices that still need a split stay client money,
  // and the invoice goes to review.
  for (const a of input.allocations) {
    if (input.compositions.has(a.invoiceId)) continue
    const reason = input.invoicesNeedingReview.get(a.invoiceId)
    if (!reason) continue
    const c = classifiedById.get(a.entryId)
    if (c && !c.review) {
      c.review = { category: 'invoice_split', sourceTable: 'invoices', sourceId: a.invoiceId, reason }
    }
  }

  // Profit-relevant recognition that follows the entry date.
  for (const c of classified) {
    for (const p of c.parts) {
      if (p.bucket === 'operating') recognition.push({ date: c.entry.date, kind: 'operating', amountInr: p.cashInr, source: c.entry.id })
      if (p.bucket === 'own_revenue_direct') recognition.push({ date: c.entry.date, kind: 'own_revenue', amountInr: p.cashInr, source: c.entry.id })
      if (p.bucket === 'extra_pay') recognition.push({ date: c.entry.date, kind: 'extra_pay', amountInr: p.cashInr, source: c.entry.id })
    }
    // Unassigned ad funding written off by review: an expense on the review date (D4).
    const unshared = c.parts.find(p => p.bucket === 'ad_prepaid')
    if (unshared) {
      const r = input.reviews.get(reviewKey('cashbook_entries', c.entry.id))
      if (r?.category === 'unassigned_ad_funding' && r.classification === 'write_off') {
        recognition.push({ date: r.reviewedOn, kind: 'ad_written_off', amountInr: unshared.cashInr, source: c.entry.id })
      }
    }
  }

  return { classified, splits, recognition }
}

/**
 * An ad-funding outflow, split by its wallet shares: client shares are paid on
 * the client's behalf, the company wallet's share is Cirqle's own marketing,
 * and whatever was never shared is prepaid platform funding (D4). The parts
 * always add up to the entry, even if the shares were over-allocated.
 */
export function adFundingParts(amountInr: number, credits: WalletCredit[]): CashPart[] {
  const total = round2(amountInr)
  const client = round2(Math.min(total, credits.filter(c => c.clientId).reduce((s, c) => s + c.amountInr, 0)))
  const company = round2(Math.min(round2(total - client), credits.filter(c => !c.clientId).reduce((s, c) => s + c.amountInr, 0)))
  const unshared = round2(total - client - company)
  const parts: CashPart[] = []
  if (client) parts.push({ bucket: 'passthrough_paid', cashInr: -client })
  if (company) parts.push({ bucket: 'operating', cashInr: -company })
  if (unshared || parts.length === 0) parts.push({ bucket: 'ad_prepaid', cashInr: -unshared })
  return parts
}

/** Scale parts by a factor and put any paisa rounding on the largest part, so they still sum to `total`. */
function scaleParts(parts: CashPart[], factor: number, total: number): CashPart[] {
  const scaled = parts.map(p => ({ bucket: p.bucket, cashInr: round2(p.cashInr * factor) }))
  const diff = round2(total - scaled.reduce((s, p) => s + p.cashInr, 0))
  if (diff && scaled.length) {
    const i = scaled.reduce((best, p, k) => (Math.abs(p.cashInr) > Math.abs(scaled[best].cashInr) ? k : best), 0)
    scaled[i].cashInr = round2(scaled[i].cashInr + diff)
  }
  return scaled
}

/** Review items raised by the classifier inside a window, de-duplicated by source. */
export function reviewItemsFrom(classified: ClassifiedEntry[], start: string, end: string): ReviewItem[] {
  const seen = new Set<string>()
  const out: ReviewItem[] = []
  for (const c of classified) {
    if (!c.review || c.entry.date < start || c.entry.date > end) continue
    const key = reviewKey(c.review.sourceTable, c.review.sourceId)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      category: c.review.category,
      sourceTable: c.review.sourceTable,
      sourceId: c.review.sourceId,
      date: c.entry.date,
      amountInr: c.entry.amountInr,
      reason: c.review.reason,
      context: {
        entryId: c.entry.id, clientId: c.entry.clientId, employeeId: c.entry.employeeId,
        category: c.entry.categoryName, reference: c.entry.reference,
      },
    })
  }
  return out
}
