/**
 * One profit period, end to end (design §3, §6, §7, §10, §11). Pure.
 *
 *   profit   = own revenue collected − own operating payments − remuneration
 *              earned − pay outside payroll − confirmed device costs
 *              − pass-through and ad funding written off
 *   eligible = profit after accumulated losses are absorbed
 *   pool     = eligible × distribution %; Capital Share + Business Reserve
 *   entitlements by capital-days
 *
 * The result carries every gate (block / warn), the review queue, the cash
 * bridge, the liabilities behind "cash available", and a fingerprint of every
 * input so a confirmed period can tell when the books under it have changed.
 */

import { createHash } from 'crypto'
import { round2 } from '@/lib/calculations/currency'
import { BUCKET_LABELS, classifyEntries, reviewItemsFrom, reviewKey, type CashBucket, type ClassifiedEntry } from './classify'
import { compositionFromReview, deriveComposition, type CompositionProblem } from './composition'
import { allocateCapitalShare, addDays, type CapitalAllocation } from './capital'
import { carryLoss, distribute, type Distribution, type LossCarry } from './distribution'
import { summarisePayroll, type PayrollSummary } from './payroll'
import type {
  CapitalMovement, CashLink, Composition, CreditRow, DeviceCost, Gate, InvoiceAllocation, InvoiceRaw,
  LedgerEntry, PayrollAllocation, PayrollRow, Review, ReviewItem, SettlementRef, Settings, WalletCredit,
} from './types'

export interface BankAccountCheck {
  id: string
  name: string
  underReconciliation: boolean
  /** A closed statement covers the period end. */
  covered: boolean
  unmatchedInPeriod: number
  /** Statement closing balance − Cash Book balance on that date; null when unknown. */
  differenceInr: number | null
  hadEntriesInPeriod: boolean
}

export interface RunInput {
  periodStart: string
  periodEnd: string
  settings: Settings
  /** Previous confirmed closing loss, or the Admin-entered opening loss for the first period (D7). */
  openingLossInr: number | null
  openingLossEntered: boolean
  previousConfirmedEnd: string | null
  confirmedRanges: { start: string; end: string }[]
  /** Every live Cash Book entry dated on or before the period end. */
  entries: LedgerEntry[]
  /** Σ bank_accounts.opening_balance. */
  accountOpeningBalancesInr: number
  allocations: InvoiceAllocation[]
  invoices: InvoiceRaw[]
  walletCredits: WalletCredit[]
  rebilledEntryIds: Set<string>
  payrollAllocations: PayrollAllocation[]
  payrollRows: PayrollRow[]
  credits: CreditRow[]
  reviews: Review[]
  cashLinks: CashLink[]
  settlements: SettlementRef[]
  deviceCosts: DeviceCost[]
  capital: CapitalMovement[]
  memberIds: string[]
  /** YYYY-MM-01 of months closed by paid payroll or an explicit lock. */
  finalizedMonths: Set<string>
  banks: BankAccountCheck[]
  obligations: { pendingEntitlementsInr: number; unpaidDeviceInr: number; reserveBalanceInr: number }
}

export interface RunComputation {
  period: { start: string; end: string; months: string[] }
  profit: {
    ownRevenueInr: number
    operatingPaymentsInr: number
    remunerationInr: number
    extraPayInr: number
    deviceCostsInr: number
    passthroughWriteoffsInr: number
    adWriteoffsInr: number
    profitInr: number
  }
  loss: LossCarry
  distribution: Distribution
  capital: CapitalAllocation
  cash: {
    openingInr: number
    closingInr: number
    byBucket: { bucket: CashBucket; label: string; amountInr: number; count: number }[]
    bridgeDifferenceInr: number
  }
  balances: {
    clientFundsHeldInr: number
    passthroughReceivableInr: number
    adPrepaidInr: number
    taxCollectedInr: number
    payrollLiabilityInr: number
  }
  freeCash: {
    closingCashInr: number
    payrollLiabilityInr: number
    clientFundsHeldInr: number
    pendingEntitlementsInr: number
    unpaidDeviceInr: number
    freeCashInr: number
    reserveBalanceInr: number
    cashAvailableInr: number
    capitalShareExceedsCash: boolean
  }
  payroll: PayrollSummary
  reviewItems: ReviewItem[]
  gates: Gate[]
  fingerprint: string
  frozenInputs: { source_table: string; source_id: string; class: string; amount_inr: number; detail: Record<string, unknown> }[]
}

/** YYYY-MM-01 for every month in [start, end]. */
export function monthsOf(start: string, end: string): string[] {
  const out: string[] = []
  let [y, m] = start.split('-').map(Number)
  const [ey, em] = end.split('-').map(Number)
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`)
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}

/** Last day of the month that `monthStart` (YYYY-MM-01) opens. */
export function monthEnd(monthStart: string): string {
  const [y, m] = monthStart.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

const PROBLEM_REASON: Record<CompositionProblem, string> = {
  mismatch: 'Invoice parts do not add up to its total — record the split',
  carried_balance: 'Invoice carries a balance brought forward — record the split',
  tax_unconfirmed: 'Tax-bearing invoice while GST/TDS treatment is unconfirmed (D1) — record the split',
}

export function computeRun(input: RunInput): RunComputation {
  const start = input.periodStart
  const end = input.periodEnd
  const months = monthsOf(start, end)
  const s = input.settings
  const inPeriod = (d: string) => d >= start && d <= end

  const reviews = new Map(input.reviews.map(r => [reviewKey(r.sourceTable, r.sourceId), r]))

  // ── Invoice compositions (derived, or an Admin's recorded split) ──────────
  const compositions = new Map<string, Composition>()
  const invoicesNeedingReview = new Map<string, string>()
  for (const inv of input.invoices) {
    const manual = reviews.get(reviewKey('invoices', inv.id))
    if (manual?.category === 'invoice_split') {
      const c = compositionFromReview(manual.detail)
      if (c) { compositions.set(inv.id, c); continue }
    }
    const d = deriveComposition(inv)
    if (d.problem) invoicesNeedingReview.set(inv.id, PROBLEM_REASON[d.problem])
    else compositions.set(inv.id, d.composition)
  }

  const payrollAllocatedEntryIds = new Set(input.payrollAllocations.map(a => a.entryId))
  const { classified, splits, recognition } = classifyEntries({
    entries: input.entries,
    allocations: input.allocations,
    compositions,
    invoicesNeedingReview,
    walletCredits: input.walletCredits,
    rebilledEntryIds: input.rebilledEntryIds,
    payrollAllocatedEntryIds,
    reviews,
    cashLinks: new Map(input.cashLinks.map(l => [l.entryId, l])),
    settlements: new Map(input.settlements.map(x => [x.id, x])),
  })

  // ── Payroll (D5) ──────────────────────────────────────────────────────────
  const paidByPayroll = new Map<string, number>()
  for (const a of input.payrollAllocations) paidByPayroll.set(a.payrollId, (paidByPayroll.get(a.payrollId) ?? 0) + a.amountInr)
  // A salary payment an Admin matched to a payslip in review settles it too.
  for (const r of input.reviews) {
    if (r.category !== 'salary_without_payroll' || r.classification !== 'payroll_settlement') continue
    const payrollId = String(r.detail?.payrollId ?? '')
    if (payrollId) paidByPayroll.set(payrollId, (paidByPayroll.get(payrollId) ?? 0) + Number(r.amountInr ?? 0))
  }
  const payroll = summarisePayroll({
    rows: input.payrollRows, paidByPayroll, credits: input.credits, reviews, months, start, end,
  })

  // ── Profit ────────────────────────────────────────────────────────────────
  const sumRec = (kind: string, upTo = end, from = start) =>
    round2(recognition.filter(r => r.kind === kind && r.date >= from && r.date <= upTo).reduce((x, r) => x + r.amountInr, 0))
  const ownRevenue = sumRec('own_revenue')
  const operating = round2(-sumRec('operating'))
  const extraPay = round2(-sumRec('extra_pay'))
  const adWriteoffs = round2(-sumRec('ad_written_off'))
  const deviceCosts = round2(input.deviceCosts.filter(d => inPeriod(d.confirmedOn)).reduce((x, d) => x + d.amountInr, 0))

  // Pass-through on an invoice written off as bad debt becomes a loss when written off.
  const recoveredByInvoice = new Map<string, number>()
  for (const sp of splits) recoveredByInvoice.set(sp.invoiceId, (recoveredByInvoice.get(sp.invoiceId) ?? 0) + sp.passInr)
  let passWriteoffs = 0
  let passWriteoffsToEnd = 0
  for (const inv of input.invoices) {
    if (inv.status !== 'bad_debt' || !inv.updatedOn || inv.updatedOn > end) continue
    const comp = compositions.get(inv.id)
    if (!comp) continue
    const lost = Math.max(0, comp.passInr - (recoveredByInvoice.get(inv.id) ?? 0))
    passWriteoffsToEnd += lost
    if (inPeriod(inv.updatedOn)) passWriteoffs += lost
  }
  passWriteoffs = round2(passWriteoffs)

  const remuneration = payroll.remunerationInr
  const profitInr = round2(ownRevenue - operating - remuneration - extraPay - deviceCosts - passWriteoffs - adWriteoffs)

  // ── Losses, distribution, capital ─────────────────────────────────────────
  const loss = carryLoss(input.openingLossInr ?? 0, profitInr)
  const distribution = distribute(loss.eligibleProfitInr, s)
  const capital = allocateCapitalShare(distribution.capitalShareInr, input.capital, input.memberIds, start, end)

  // ── Cash bridge ───────────────────────────────────────────────────────────
  const signedOf = (e: LedgerEntry) => (e.type === 'inflow' ? e.amountInr : -e.amountInr)
  const opening = round2(input.accountOpeningBalancesInr + input.entries.filter(e => e.date < start).reduce((x, e) => x + signedOf(e), 0))
  const closing = round2(input.accountOpeningBalancesInr + input.entries.filter(e => e.date <= end).reduce((x, e) => x + signedOf(e), 0))
  const periodEntries = classified.filter(c => inPeriod(c.entry.date))
  const buckets = new Map<CashBucket, { amount: number; count: number }>()
  for (const c of periodEntries) {
    for (const p of c.parts) {
      const b = buckets.get(p.bucket) ?? { amount: 0, count: 0 }
      b.amount += p.cashInr
      b.count += 1
      buckets.set(p.bucket, b)
    }
  }
  const byBucket = [...buckets.entries()]
    .map(([bucket, v]) => ({ bucket, label: BUCKET_LABELS[bucket], amountInr: round2(v.amount), count: v.count }))
    .sort((a, b) => Math.abs(b.amountInr) - Math.abs(a.amountInr))
  const bridgeDifference = round2(closing - opening - byBucket.reduce((x, b) => x + b.amountInr, 0))

  // ── Balances at period end ────────────────────────────────────────────────
  const upToEnd = classified.filter(c => c.entry.date <= end)
  const partSum = (bucket: CashBucket, list: ClassifiedEntry[] = upToEnd) =>
    round2(list.reduce((x, c) => x + c.parts.filter(p => p.bucket === bucket).reduce((y, p) => y + p.cashInr, 0), 0))
  const recToEnd = (kind: string) =>
    round2(recognition.filter(r => r.kind === kind && r.date <= end).reduce((x, r) => x + r.amountInr, 0))
  const receivedFromClients = partSum('client_receipts')
  // Excess over an invoice's parts stays client money, so it is not subtracted.
  const recognisedFromReceipts = round2(recognition
    .filter(r => r.fromReceipt && r.date <= end && r.kind !== 'excess_held')
    .reduce((y, r) => y + r.amountInr, 0))
  const clientFundsHeld = round2(Math.max(0, receivedFromClients - recognisedFromReceipts))
  const passReceivable = round2(Math.max(0, -partSum('passthrough_paid') - recToEnd('pass_recovered') - passWriteoffsToEnd))
  const adPrepaid = round2(Math.max(0, -partSum('ad_prepaid') + recToEnd('ad_written_off')))
  const taxCollected = recToEnd('tax_collected')

  // ── Free cash and cash available (D9, D13) ────────────────────────────────
  const freeCashInr = round2(closing - payroll.liabilityInr - clientFundsHeld
    - input.obligations.pendingEntitlementsInr - input.obligations.unpaidDeviceInr)
  // The earmark is deducted once, and includes this period's allocation.
  const reserveBalance = round2(input.obligations.reserveBalanceInr + distribution.reserveInr)
  const cashAvailable = round2(freeCashInr - reserveBalance)
  const allocatedCapitalShare = round2(distribution.capitalShareInr - capital.unallocatedInr)
  const exceeds = allocatedCapitalShare > cashAvailable

  // ── Review queue ──────────────────────────────────────────────────────────
  const reviewItems: ReviewItem[] = [...reviewItemsFrom(classified, start, end), ...payroll.reviewItems]
  const prepaidCutoff = addDays(end, -s.adPrepaidBlockDays)
  let agedPrepaid = 0
  let agedPrepaidInr = 0
  for (const c of upToEnd) {
    const unshared = c.parts.find(p => p.bucket === 'ad_prepaid' && p.cashInr !== 0)
    if (!unshared) continue
    const r = reviews.get(reviewKey('cashbook_entries', c.entry.id))
    if (r?.category === 'unassigned_ad_funding' && r.classification === 'write_off') continue
    reviewItems.push({
      category: 'unassigned_ad_funding', sourceTable: 'cashbook_entries', sourceId: c.entry.id,
      date: c.entry.date, amountInr: -unshared.cashInr,
      reason: c.entry.date < prepaidCutoff
        ? `Ad-platform funding unassigned for more than ${s.adPrepaidBlockDays} days — share it to a wallet or write it off`
        : 'Ad-platform funding not yet shared to a client or company wallet',
      context: { entryId: c.entry.id, aged: c.entry.date < prepaidCutoff },
    })
    if (c.entry.date < prepaidCutoff) { agedPrepaid++; agedPrepaidInr += -unshared.cashInr }
  }
  const blockingReviews = reviewItems.filter(r => r.category !== 'unassigned_ad_funding')

  // ── Gates ─────────────────────────────────────────────────────────────────
  const gates: Gate[] = []
  const block = (key: string, message: string, extra: Partial<Gate> = {}) => gates.push({ key, level: 'block', message, ...extra })
  const warn = (key: string, message: string, extra: Partial<Gate> = {}) => gates.push({ key, level: 'warn', message, ...extra })

  if (Math.abs(bridgeDifference) > 0.004) {
    block('bridge', 'Cash bridge does not balance — opening + movements ≠ closing', { amountInr: bridgeDifference })
  }
  const unclassified = periodEntries.filter(c => c.parts.some(p => p.bucket === 'unclassified'))
  if (unclassified.length) block('unclassified', 'Cash Book entries with no category or an unmapped category', { count: unclassified.length })
  if (blockingReviews.length) block('reviews', 'Items waiting for review', { count: blockingReviews.length })
  const unlinked = periodEntries.filter(c => c.unlinked)
  if (unlinked.length) {
    block('unlinked', 'Capital or payout entries not linked to an investor movement or settlement', { count: unlinked.length })
  }
  if (payroll.monthsWithoutPayroll.length) {
    block('payroll_missing', `No payroll recorded for ${payroll.monthsWithoutPayroll.map(m => m.slice(0, 7)).join(', ')}`)
  }
  const notFinal = months.filter(m => !input.finalizedMonths.has(m))
  if (notFinal.length) {
    block('months_open', `Months not closed (paid payroll or a lock): ${notFinal.map(m => m.slice(0, 7)).join(', ')}`)
  }
  if (agedPrepaid) {
    block('ad_prepaid_aged', `Ad-platform funding unassigned for more than ${s.adPrepaidBlockDays} days (D4)`, { count: agedPrepaid, amountInr: round2(agedPrepaidInr) })
  }
  const oldestUnrecovered = oldestUnrecoveredPassthrough(upToEnd, recToEnd('pass_recovered') + passWriteoffsToEnd)
  if (oldestUnrecovered && oldestUnrecovered < addDays(end, -s.passthroughWarnDays)) {
    warn('passthrough_aged', `Pass-through costs unrecovered for more than ${s.passthroughWarnDays} days (oldest ${oldestUnrecovered})`, { amountInr: passReceivable })
  }
  for (const b of input.banks) {
    if (b.underReconciliation) {
      if (!b.covered) block(`bank_${b.id}`, `${b.name}: no closed bank statement covers ${end}`)
      if (b.unmatchedInPeriod) block(`bank_unmatched_${b.id}`, `${b.name}: unmatched statement lines in the period`, { count: b.unmatchedInPeriod })
      if (b.differenceInr != null && Math.abs(b.differenceInr) > s.toleranceInr) {
        block(`bank_diff_${b.id}`, `${b.name}: statement and Cash Book differ by more than ₹${s.toleranceInr}`, { amountInr: b.differenceInr })
      }
    } else if (b.hadEntriesInPeriod) {
      warn(`bank_unreconciled_${b.id}`, `${b.name}: not under bank reconciliation — its balance is not checked against a statement`)
    }
  }
  if (!input.previousConfirmedEnd && !input.openingLossEntered) {
    block('opening_loss', 'First period: enter the scheme’s opening accumulated loss (D7)')
  }
  if (input.previousConfirmedEnd && start !== addDays(input.previousConfirmedEnd, 1)) {
    block('order', `Periods must follow on from ${input.previousConfirmedEnd} without a gap`)
  }
  if (input.confirmedRanges.some(r => r.start <= end && r.end >= start)) {
    block('overlap', 'This period overlaps a confirmed period')
  }
  for (const w of payroll.warnings) warn(`payroll_${w.key}`, w.message, { amountInr: w.amountInr, count: w.count })
  if (capital.unallocatedInr > 0) {
    warn('no_capital', 'No eligible capital in this period — the Capital Share stays retained', { amountInr: capital.unallocatedInr })
  }
  if (exceeds && allocatedCapitalShare > 0) {
    warn('cash_cover', 'Capital Share is more than the cash available after liabilities and the reserve — confirmation needs a written acknowledgement (D13)', { amountInr: round2(allocatedCapitalShare - cashAvailable) })
  }

  // ── Fingerprint and frozen inputs ─────────────────────────────────────────
  const frozenInputs: RunComputation['frozenInputs'] = []
  for (const c of periodEntries) {
    frozenInputs.push({
      source_table: 'cashbook_entries', source_id: c.entry.id,
      class: c.parts.map(p => p.bucket).join('+'),
      amount_inr: round2(c.entry.type === 'inflow' ? c.entry.amountInr : -c.entry.amountInr),
      detail: { date: c.entry.date, category: c.entry.categoryName, account: c.entry.accountCode, parts: c.parts },
    })
  }
  for (const sp of splits.filter(x => inPeriod(x.recognisedOn))) {
    frozenInputs.push({
      source_table: 'cashbook_invoice_allocations', source_id: `${sp.entryId}:${sp.invoiceId}`, class: 'allocation_split',
      amount_inr: round2(sp.passInr + sp.taxInr + sp.ownInr + sp.excessInr),
      detail: { recognisedOn: sp.recognisedOn, pass: sp.passInr, tax: sp.taxInr, own: sp.ownInr, excess: sp.excessInr },
    })
  }
  for (const r of payroll.rows) {
    frozenInputs.push({ source_table: 'payroll', source_id: r.id, class: 'remuneration', amount_inr: r.gross, detail: { month: r.month, net: r.net, paid: r.paid } })
  }
  for (const d of input.deviceCosts.filter(x => inPeriod(x.confirmedOn))) {
    frozenInputs.push({ source_table: 'profit_share_device_valuations', source_id: d.valuationId, class: 'device_cost', amount_inr: d.amountInr, detail: { confirmedOn: d.confirmedOn } })
  }
  for (const m of input.capital.filter(x => x.status === 'approved' && x.effectiveOn <= end)) {
    frozenInputs.push({ source_table: 'profit_share_capital', source_id: m.id, class: `capital_${m.direction}`, amount_inr: m.amountInr, detail: { member: m.memberId, effectiveOn: m.effectiveOn, weight: m.weight } })
  }

  const fingerprint = fingerprintOf({
    start, end, settings: { ...s, id: null }, openingLoss: input.openingLossInr,
    entries: input.entries.map(e => [e.id, e.date, e.type, e.amountInr, e.categoryId, e.accountCode, e.clientId, e.employeeId, e.transferRef, e.reversalOf]),
    allocations: input.allocations.map(a => [a.entryId, a.invoiceId, a.amountInr, a.allocatedOn]),
    compositions: [...compositions.entries()],
    wallet: input.walletCredits.map(w => [w.entryId, w.clientId, w.amountInr]),
    payroll: payroll.rows.map(r => [r.id, r.gross, r.net, r.paid]),
    credits: input.credits.filter(c => c.date <= end).map(c => [c.id, c.type, c.amountInr, c.date]),
    reviews: input.reviews.map(r => [r.sourceTable, r.sourceId, r.classification, r.amountInr]),
    capital: input.capital.filter(m => m.status === 'approved').map(m => [m.id, m.direction, m.amountInr, m.weight, m.effectiveOn]),
    deviceCosts: input.deviceCosts.map(d => [d.valuationId, d.amountInr, d.confirmedOn]),
    links: input.cashLinks.map(l => [l.entryId, l.ownerKind, l.ownerId]),
  })

  return {
    period: { start, end, months },
    profit: {
      ownRevenueInr: ownRevenue,
      operatingPaymentsInr: operating,
      remunerationInr: remuneration,
      extraPayInr: extraPay,
      deviceCostsInr: deviceCosts,
      passthroughWriteoffsInr: passWriteoffs,
      adWriteoffsInr: adWriteoffs,
      profitInr,
    },
    loss,
    distribution,
    capital,
    cash: { openingInr: opening, closingInr: closing, byBucket, bridgeDifferenceInr: bridgeDifference },
    balances: {
      clientFundsHeldInr: clientFundsHeld,
      passthroughReceivableInr: passReceivable,
      adPrepaidInr: adPrepaid,
      taxCollectedInr: taxCollected,
      payrollLiabilityInr: payroll.liabilityInr,
    },
    freeCash: {
      closingCashInr: closing,
      payrollLiabilityInr: payroll.liabilityInr,
      clientFundsHeldInr: clientFundsHeld,
      pendingEntitlementsInr: round2(input.obligations.pendingEntitlementsInr),
      unpaidDeviceInr: round2(input.obligations.unpaidDeviceInr),
      freeCashInr,
      reserveBalanceInr: reserveBalance,
      cashAvailableInr: cashAvailable,
      capitalShareExceedsCash: exceeds && allocatedCapitalShare > 0,
    },
    payroll,
    reviewItems,
    gates,
    fingerprint,
    frozenInputs,
  }
}

/** FIFO: the date of the oldest pass-through payment not yet covered by recoveries. */
function oldestUnrecoveredPassthrough(list: ClassifiedEntry[], recoveredInr: number): string | null {
  const paid = list
    .flatMap(c => c.parts.filter(p => p.bucket === 'passthrough_paid').map(p => ({ date: c.entry.date, amount: -p.cashInr })))
    .sort((a, b) => a.date.localeCompare(b.date))
  let left = recoveredInr
  for (const p of paid) {
    if (left >= p.amount - 0.004) { left -= p.amount; continue }
    return p.date
  }
  return null
}

export function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export const isBlocked = (gates: Gate[]) => gates.some(g => g.level === 'block')
