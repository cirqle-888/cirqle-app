/**
 * What a collection is made of (design §3.4) and the order a partial payment
 * is applied in (D2, confirmed): pass-through first, then applicable tax, then
 * Cirqle's own revenue.
 *
 * The invoice tables already separate pass-through money from Cirqle's fee
 * (billing.ts writeInvoiceLines): ad spend lives in invoice_ad_spend_items,
 * rebilled costs in invoice_expense_items.original_amount_inr, fees in
 * invoice_items. So a receipt's composition is DERIVED from the invoice it is
 * allocated to. When the parts do not add up to the invoice total, or the
 * invoice carries a balance brought forward or tax (D1 open), nothing is
 * guessed: the invoice goes to review and an Admin records the split.
 */

import { round2 } from '@/lib/calculations/currency'
import type { Composition, InvoiceAllocation, InvoiceRaw } from './types'

export type CompositionProblem = 'mismatch' | 'carried_balance' | 'tax_unconfirmed'

export interface DerivedComposition {
  composition: Composition
  problem: CompositionProblem | null
}

/** The parts must add up to the total within ₹1 or 0.1%, whichever is larger. */
export function compositionTolerance(totalInr: number): number {
  return Math.max(1, Math.abs(totalInr) * 0.001)
}

export function deriveComposition(inv: InvoiceRaw): DerivedComposition {
  const rate = inv.exchangeRate > 0 ? inv.exchangeRate : 1
  const totalInr = round2(inv.totalAmountInr ?? inv.totalAmount * rate)
  const composition: Composition = {
    // Discounts reduce Cirqle's own revenue only — the conservative reading.
    ownInr: round2((inv.itemsTotal + inv.markupTotal - inv.discountAmount) * rate),
    passInr: round2(inv.adSpendInr + inv.expenseOriginalInr),
    taxInr: round2(inv.taxAmount * rate),
    carriedInr: round2(inv.previousBalance * rate),
    totalInr,
  }
  let problem: CompositionProblem | null = null
  const sum = composition.ownInr + composition.passInr + composition.taxInr + composition.carriedInr
  if (Math.abs(sum - totalInr) > compositionTolerance(totalInr)) problem = 'mismatch'
  // How allocations treat a carried balance is unverified (§13.4) — review it.
  if (composition.carriedInr !== 0) problem = 'carried_balance'
  // D1 is open: no tax treatment is applied automatically.
  if (composition.taxInr > 0) problem = 'tax_unconfirmed'
  return { composition, problem }
}

/** A manual split recorded in a review overrides the derived one. */
export function compositionFromReview(detail: Record<string, unknown> | null): Composition | null {
  if (!detail) return null
  const n = (k: string) => Number(detail[k] ?? 0) || 0
  const c: Composition = {
    ownInr: round2(n('ownInr')),
    passInr: round2(n('passInr')),
    taxInr: round2(n('taxInr')),
    carriedInr: round2(n('carriedInr')),
    totalInr: round2(n('totalInr')),
  }
  return c
}

export interface AllocationSplit {
  entryId: string
  invoiceId: string
  recognisedOn: string
  passInr: number
  taxInr: number
  ownInr: number
  /** Allocated beyond everything the invoice is made of (carried or over-allocated). */
  excessInr: number
}

/**
 * Apply each invoice's allocations in recognition order, filling pass-through,
 * then tax, then own revenue (D2). A rupee lands in exactly one bucket, so
 * Σ split === Σ allocated for every invoice.
 */
export function splitAllocations(
  allocations: InvoiceAllocation[],
  entryDates: Map<string, string>,
  compositions: Map<string, Composition>,
): AllocationSplit[] {
  const byInvoice = new Map<string, InvoiceAllocation[]>()
  for (const a of allocations) {
    const list = byInvoice.get(a.invoiceId) ?? []
    list.push(a)
    byInvoice.set(a.invoiceId, list)
  }
  const out: AllocationSplit[] = []
  for (const [invoiceId, list] of byInvoice) {
    const comp = compositions.get(invoiceId)
    if (!comp) continue
    const ordered = list
      .map(a => ({ a, on: laterOf(entryDates.get(a.entryId) ?? a.allocatedOn, a.allocatedOn) }))
      .sort((x, y) => x.on.localeCompare(y.on) || x.a.entryId.localeCompare(y.a.entryId))
    let passLeft = Math.max(0, comp.passInr)
    let taxLeft = Math.max(0, comp.taxInr)
    let ownLeft = Math.max(0, comp.ownInr)
    for (const { a, on } of ordered) {
      let left = round2(a.amountInr)
      const take = (cap: number) => { const t = round2(Math.min(cap, left)); left = round2(left - t); return t }
      const pass = take(passLeft); passLeft = round2(passLeft - pass)
      const tax = take(taxLeft); taxLeft = round2(taxLeft - tax)
      const own = take(ownLeft); ownLeft = round2(ownLeft - own)
      out.push({ entryId: a.entryId, invoiceId, recognisedOn: on, passInr: pass, taxInr: tax, ownInr: own, excessInr: left })
    }
  }
  return out
}

export function laterOf(a: string, b: string): string {
  return a >= b ? a : b
}
