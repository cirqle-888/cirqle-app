/**
 * Statement of Account — the ledger builder.
 *
 * Pure: no Supabase, no React. Everything it needs is passed in, so the rules
 * below are unit-testable and the page stays a thin caller.
 *
 * THE TWO RULES THAT MATTER, both learned from the live data:
 *
 * 1. Money received lives in `cashbook_invoice_allocations`, NOT `payments`.
 *    Of 228 invoices carrying a paid amount, 202 are settled purely through
 *    allocations and only 12 through the `payments` table. A ledger built from
 *    `payments` alone shows a client almost none of what they have paid.
 *
 * 2. A direct payment is recorded TWICE. recordInvoicePayment writes the
 *    payment row and auto-creates a matching cashbook inflow, which then gets
 *    allocated — so the same money appears in both tables. Summing both
 *    double-counts it (14 invoices here). Credits are therefore de-duplicated
 *    on (invoice, date, amount), the same correlation the invoice detail panel
 *    already uses to find a payment's cashbook entry.
 */
import { round2 } from '@/lib/calculations/currency'
import { todayISO } from '@/lib/utils/local-date'

export type Currency = string

/** An invoice as the ledger needs it. Amounts are in the invoice's own currency. */
export interface StatementInvoice {
  id: string
  invoice_number: string | null
  issue_date: string | null
  due_date: string | null
  status: string | null
  currency: Currency | null
  /** Native-currency figures — authoritative for what the client owes. */
  total_amount: number | null
  paid_amount: number | null
  /** INR mirrors — used only to derive the native/INR rate. */
  total_amount_inr: number | null
  paid_amount_inr: number | null
  exchange_rate: number | null
}

/** A dated credit against an invoice. `amountInr` is always INR. */
export interface StatementCredit {
  invoiceId: string
  date: string
  amountInr: number
  /** 'payment' = payments table, 'allocation' = cashbook allocation. */
  source: 'payment' | 'allocation'
  reference?: string | null
  method?: string | null
}

/**
 * 'writeoff' is the balancing line for a bad debt: the invoice stays on the
 * statement as billed, and this line takes off what was never paid, so the
 * history is honest and the balance does not ask for money that was given up.
 */
export type LedgerKind = 'invoice' | 'credit' | 'writeoff'

export interface LedgerRow {
  kind: LedgerKind
  date: string
  /** Invoice number, or the reference/method for a credit. */
  ref: string
  description: string
  /** Money the client owes us (an invoice). Native currency. */
  debit: number
  /** Money received. Native currency. */
  credit: number
  /** Balance after this row. */
  balance: number
  invoiceId: string
}

export interface AgingBucket {
  label: string
  /** Inclusive lower bound in days past due. */
  fromDays: number
  /** Exclusive upper bound, or null for "and older". */
  toDays: number | null
  amount: number
}

export interface StatementResult {
  currency: Currency
  from: string
  to: string
  openingBalance: number
  closingBalance: number
  rows: LedgerRow[]
  totalBilled: number
  /** Money actually received. Write-offs are not in it. */
  totalReceived: number
  /** Unpaid balances of bad-debt invoices, taken off the account. */
  totalWrittenOff: number
  /** Unpaid balance per bucket, as of `to`. Only invoices still owing appear. */
  aging: AgingBucket[]
  /** Sum of the aging buckets — the part of the closing balance that is due. */
  totalOutstanding: number
  invoiceCount: number
  /**
   * Invoices whose stored `paid_amount` disagrees with the dated credits behind
   * it. Not cosmetic: INV-2606-058 in this database is a 44 AED invoice with
   * paid_amount = 1200 — the INR figure written into the native field — which
   * makes it look overpaid by 1,156 AED. The ledger reports what the dated
   * credits actually say and hands the discrepancy back so the UI can flag it,
   * rather than silently inheriting a books error or silently hiding it.
   */
  discrepancies: {
    invoiceId: string
    invoiceNumber: string
    storedPaid: number
    ledgerPaid: number
  }[]
}

/** Native-per-INR divisor for an invoice. 1 for INR, else derived from its own pair. */
export function nativeRate(inv: StatementInvoice): number {
  const t = Number(inv.total_amount || 0)
  const tInr = Number(inv.total_amount_inr || 0)
  if (t > 0 && tInr > 0) return tInr / t
  const r = Number(inv.exchange_rate || 0)
  return r > 0 ? r : 1
}

/**
 * Drop credits that are the same money recorded twice — a `payments` row and
 * the allocation of the cashbook entry it auto-created. Matched on invoice +
 * date + amount, keeping the allocation (the settled side of the books).
 */
export function dedupeCredits(credits: StatementCredit[]): StatementCredit[] {
  const seen = new Set<string>()
  const key = (c: StatementCredit) => `${c.invoiceId}|${c.date}|${c.amountInr.toFixed(2)}`
  // Allocations first, so a duplicated pair keeps the allocation.
  const ordered = [...credits].sort((a, b) =>
    a.source === b.source ? 0 : a.source === 'allocation' ? -1 : 1)
  const out: StatementCredit[] = []
  for (const c of ordered) {
    const k = key(c)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(c)
  }
  return out
}

const DAY = 86400000
function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + 'T00:00:00Z')
  const b = Date.parse(toIso + 'T00:00:00Z')
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.floor((b - a) / DAY)
}

/** The date an invoice starts ageing from — its due date, else its issue date. */
function ageFrom(inv: StatementInvoice): string | null {
  return inv.due_date || inv.issue_date || null
}

export const AGING_BUCKETS: { label: string; fromDays: number; toDays: number | null }[] = [
  { label: 'Not yet due', fromDays: -Infinity, toDays: 1 },
  { label: '0–30 days',   fromDays: 1,   toDays: 31 },
  { label: '31–60 days',  fromDays: 31,  toDays: 61 },
  { label: '61–90 days',  fromDays: 61,  toDays: 91 },
  { label: '90+ days',    fromDays: 91,  toDays: null },
]

export interface BuildStatementInput {
  invoices: StatementInvoice[]
  credits: StatementCredit[]
  /** Inclusive ISO date bounds. */
  from: string
  to: string
  /** Statement currency. Every client in this database bills in exactly one. */
  currency: Currency
  /**
   * The date the ageing is measured from. Defaults to `to`, clamped to today.
   *
   * The clamp matters: "All time" passes to = 9999-12-31, and ageing a
   * future-dated invoice against the year 9999 dropped a not-yet-due invoice
   * into "90+ days". Ageing answers "how late is this NOW", so it can never be
   * measured from a date that has not happened.
   */
  asOf?: string
}

/**
 * Opening balance, the dated ledger, closing balance and aging.
 *
 * Opening balance is everything billed on or before the day BEFORE `from`,
 * minus everything received in the same window — so the statement continues a
 * running account rather than starting from zero, which is what makes it a
 * statement rather than an invoice list.
 */
export function buildStatement(input: BuildStatementInput): StatementResult {
  const { from, to, currency } = input
  const byId = new Map(input.invoices.map(i => [i.id, i]))
  const credits = dedupeCredits(input.credits).filter(c => byId.has(c.invoiceId))

  // Native-currency amount for a credit, via its own invoice's rate.
  const creditNative = (c: StatementCredit): number => {
    const inv = byId.get(c.invoiceId)!
    return round2(c.amountInr / nativeRate(inv))
  }

  const invDate = (i: StatementInvoice) => i.issue_date || ''

  // A cancelled invoice was never a charge: it is left off the statement
  // entirely (a replacement invoice, if any, carries the work). Counting it
  // put phantom balances on 13 clients while the aging table, which already
  // skipped it, said ₹0 — the same function contradicting itself.
  const charged = input.invoices.filter(i => i.status !== 'cancelled')

  // A bad debt WAS billed, then given up. It stays as an invoice, followed by
  // a write-off of whatever was never received on it, so it nets to zero.
  // There is no write-off date in the data, so the line sits on the invoice's
  // own date, straight after it.
  const allReceived = new Map<string, number>()
  for (const c of credits) {
    allReceived.set(c.invoiceId, round2((allReceived.get(c.invoiceId) || 0) + creditNative(c)))
  }
  const writeOffOf = (inv: StatementInvoice): number =>
    inv.status === 'bad_debt'
      ? Math.max(0, round2(Number(inv.total_amount || 0) - (allReceived.get(inv.id) || 0)))
      : 0

  let opening = 0
  for (const inv of charged) {
    const d = invDate(inv)
    if (d && d < from) opening += Number(inv.total_amount || 0) - writeOffOf(inv)
  }
  for (const c of credits) {
    if (c.date < from) opening -= creditNative(c)
  }
  opening = round2(opening)

  const rows: LedgerRow[] = []
  for (const inv of charged) {
    const d = invDate(inv)
    if (!d || d < from || d > to) continue
    rows.push({
      kind: 'invoice',
      date: d,
      ref: inv.invoice_number || '—',
      description: 'Invoice',
      debit: round2(Number(inv.total_amount || 0)),
      credit: 0,
      balance: 0,
      invoiceId: inv.id,
    })
    const writeOff = writeOffOf(inv)
    if (writeOff > 0) {
      rows.push({
        kind: 'writeoff',
        date: d,
        ref: inv.invoice_number || '—',
        description: 'Written off (bad debt)',
        debit: 0,
        credit: writeOff,
        balance: 0,
        invoiceId: inv.id,
      })
    }
  }
  for (const c of credits) {
    if (c.date < from || c.date > to) continue
    const inv = byId.get(c.invoiceId)!
    rows.push({
      kind: 'credit',
      date: c.date,
      ref: c.reference || inv.invoice_number || '—',
      description: c.method ? `Payment received · ${c.method}` : 'Payment received',
      debit: 0,
      credit: creditNative(c),
      balance: 0,
      invoiceId: c.invoiceId,
    })
  }

  // Oldest first; on the same day an invoice is raised, then written off,
  // then paid. The sort is stable, so a write-off stays after its invoice.
  const order: Record<LedgerKind, number> = { invoice: 0, writeoff: 1, credit: 2 }
  rows.sort((a, b) =>
    a.date === b.date ? order[a.kind] - order[b.kind] : a.date.localeCompare(b.date))

  let running = opening
  let totalBilled = 0
  let totalReceived = 0
  let totalWrittenOff = 0
  for (const r of rows) {
    running = round2(running + r.debit - r.credit)
    r.balance = running
    totalBilled += r.debit
    if (r.kind === 'writeoff') totalWrittenOff += r.credit
    else totalReceived += r.credit
  }

  // ── Aging ─────────────────────────────────────────────────────────────────
  // Per invoice: what is still owed on it, bucketed by how long it has been due.
  const today = todayISO()
  const asOf = input.asOf ?? (to > today ? today : to)

  // What each invoice has actually received, from its dated credits.
  const receivedByInvoice = new Map<string, number>()
  for (const c of credits) {
    if (c.date > asOf) continue
    receivedByInvoice.set(c.invoiceId, round2((receivedByInvoice.get(c.invoiceId) || 0) + creditNative(c)))
  }

  const discrepancies: StatementResult['discrepancies'] = []
  for (const invoice of input.invoices) {
    const stored = round2(Number(invoice.paid_amount || 0))
    const ledgerPaid = receivedByInvoice.get(invoice.id) || 0
    if (Math.abs(stored - ledgerPaid) > 0.5) {
      discrepancies.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoice_number || '—',
        storedPaid: stored,
        ledgerPaid,
      })
    }
  }

  const buckets: AgingBucket[] = AGING_BUCKETS.map(b => ({ ...b, amount: 0 }))
  let totalOutstanding = 0
  for (const inv of input.invoices) {
    const d = invDate(inv)
    if (!d || d > asOf) continue
    if (inv.status === 'cancelled' || inv.status === 'bad_debt') continue
    // Owed from the LEDGER, not from paid_amount — see `discrepancies`.
    const owed = round2(Number(inv.total_amount || 0) - (receivedByInvoice.get(inv.id) || 0))
    if (owed <= 0) continue
    const anchor = ageFrom(inv)
    const overdueDays = anchor ? daysBetween(anchor, asOf) : 0
    const bucket = buckets.find(b =>
      overdueDays >= b.fromDays && (b.toDays === null || overdueDays < b.toDays))
    if (bucket) bucket.amount = round2(bucket.amount + owed)
    totalOutstanding = round2(totalOutstanding + owed)
  }

  return {
    currency,
    from,
    to,
    openingBalance: opening,
    closingBalance: round2(running),
    rows,
    totalBilled: round2(totalBilled),
    totalReceived: round2(totalReceived),
    totalWrittenOff: round2(totalWrittenOff),
    aging: buckets,
    totalOutstanding,
    invoiceCount: rows.filter(r => r.kind === 'invoice').length,
    discrepancies,
  }
}
