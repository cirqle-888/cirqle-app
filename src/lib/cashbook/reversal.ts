/**
 * Returned / reversed cash-book entries — the rules, pure.
 *
 * When the bank hands a payment back (a salary NEFT bounces, a client's
 * payment is refunded), the original entry is not deleted: it happened, and
 * the bank statement shows both movements. A REVERSAL is recorded instead —
 * an entry of the opposite type, on the same account, in the SAME category,
 * linked by `reversal_of`.
 *
 * Same category is what makes reports right without each one knowing about
 * reversals: the P&L sums signed amounts per category, so a ₹5,353 salary
 * and its ₹5,353 return net to zero under Salaries. Cash-flow totals treat
 * the reversal as a reduction of the original's side, never as new income
 * (finance/cash-flow).
 *
 * The allocations the original carried are released (its invoice goes back
 * to unpaid, its payslip to pending) and remembered on the allocation row
 * (`released_by_entry_id`), so deleting the reversal puts exactly those back.
 *
 * ── CREDIT GIVEN / CREDIT RETURN ──────────────────────────────────────────
 *
 * These two categories are LOANS AND ADVANCES, not returns: "Credit Given" is
 * money lent out and expected back, "Credit Return" is it coming back. Both
 * are `financial`, outside P&L, and each writes a row in the credit ledger
 * (Payroll → Credits) that tracks who owes what. A bounced bank payment is
 * NOT a Credit Return — that would read as a loan being repaid. And because
 * a credit-ledger row has no link back to its cash-book entry, reversing one
 * here could not correct the balance owed; those entries are refused, with
 * the Credits tab named as the place to fix them.
 */

import { round2 } from '@/lib/calculations/currency'

export const CREDIT_ACCOUNT_CODES: ReadonlySet<string> =
  new Set(['financial.credit_given', 'financial.credit_return'])

export interface ReversibleEntry {
  id: string
  type: 'inflow' | 'outflow' | string
  bank_account_id?: string | null
  category_id?: string | null
  client_id?: string | null
  employee_id?: string | null
  scope?: string | null
  currency?: string | null
  amount?: number | null
  exchange_rate?: number | null
  amount_inr?: number | null
  rate_source?: string | null
  rate_date?: string | null
  entry_date?: string | null
  description?: string | null
  reference?: string | null
  transfer_ref?: string | null
  reversal_of?: string | null
  deleted_at?: string | null
}

export interface ReverseContext {
  /** Ids of entries that already have a live reversal. */
  reversedIds?: ReadonlySet<string>
  /** The original's category account_code, e.g. 'opex.salaries'. */
  accountCode?: string | null
  /** Invoice number when the entry is rebilled on a non-draft invoice. */
  billedOnIssuedInvoice?: string | null
}

/** Why `entry` cannot be reversed, or null when it can. */
export function reverseBlocker(entry: ReversibleEntry, ctx: ReverseContext = {}): string | null {
  if (entry.deleted_at) return 'The entry is deleted'
  if (entry.transfer_ref) return 'A transfer moves money between your own accounts — edit or delete the transfer instead'
  if (entry.reversal_of) return 'This entry is itself a reversal — delete it to undo the reversal'
  if (ctx.reversedIds?.has(entry.id)) return 'This entry has already been reversed'
  if (!(Math.abs(Number(entry.amount_inr) || 0) > 0)) return 'The entry has no amount'
  if (!entry.bank_account_id) return 'The entry has no account to return the money to'
  if (ctx.accountCode && CREDIT_ACCOUNT_CODES.has(ctx.accountCode)) {
    return 'Credit Given / Credit Return entries are tracked on Payroll → Credits — record the opposite movement there'
  }
  if (ctx.billedOnIssuedInvoice) {
    return `This expense is already billed to the client on ${ctx.billedOnIssuedInvoice} — adjust that invoice first`
  }
  return null
}

export interface ReversalOptions {
  /** When the bank returned the money (YYYY-MM-DD). */
  entry_date: string
  /** Optional reason, e.g. "Account closed — NEFT returned". */
  note?: string | null
}

/** The reversal row to insert. Assumes `reverseBlocker(original)` is null. */
export function buildReversalRow(original: ReversibleEntry, opts: ReversalOptions) {
  const what = (original.description || '').trim() || 'entry'
  const note = (opts.note || '').trim()
  return {
    type: original.type === 'inflow' ? 'outflow' : 'inflow',
    bank_account_id: original.bank_account_id ?? null,
    category_id: original.category_id ?? null,
    client_id: original.client_id ?? null,
    employee_id: original.employee_id ?? null,
    scope: original.scope ?? null,
    currency: original.currency || 'INR',
    amount: round2(Math.abs(Number(original.amount ?? original.amount_inr) || 0)),
    // The ORIGINAL's rate, not today's: a reversal undoes the original at the
    // value it was booked at, so the two net to exactly zero in INR.
    exchange_rate: Number(original.exchange_rate) || 1,
    amount_inr: round2(Math.abs(Number(original.amount_inr) || 0)),
    rate_source: original.rate_source || 'manual',
    rate_date: original.rate_date || original.entry_date || opts.entry_date,
    entry_date: opts.entry_date,
    description: note ? `Returned: ${what} — ${note}` : `Returned: ${what}`,
    reference: original.reference ?? null,
    // Never copied: an invoice_id on insert auto-allocates the full amount
    // (trigger auto_create_allocation_on_entry), which is the opposite of
    // what a reversal is for.
    invoice_id: null,
    reversal_of: original.id,
  }
}

/** Ids of entries with a live reversal among `rows`. */
export function reversedIdsOf(rows: readonly { reversal_of?: string | null; deleted_at?: string | null }[]): Set<string> {
  const ids = new Set<string>()
  for (const r of rows) if (r.reversal_of && !r.deleted_at) ids.add(r.reversal_of)
  return ids
}
