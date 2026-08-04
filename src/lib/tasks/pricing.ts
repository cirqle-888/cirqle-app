/**
 * Task Pricing Engine — the single source of truth for what a task bills.
 *
 * Pure and framework-free (no 'use client'/'use server') so the Add Task form,
 * the shared Edit Task modal, the bulk recalc tool, and server actions all run
 * the SAME arithmetic. Before this existed the formula was re-implemented four
 * times and had already drifted: the Edit modal recomputed the matrix price on
 * every save and pushed it over a retainer-covered task's zero, so the server's
 * anti-double-billing guard rejected the write and NO edit to a covered task —
 * not even a title change — could be saved.
 *
 * Two rules live here, and nowhere else:
 *   1. computeTaskAmount  — what the pricing matrix says the work is worth.
 *   2. effectiveBillingAmount — what the CLIENT is actually charged, which is
 *      zero while a retainer covers the task. Rule 2 always wraps rule 1.
 */

export type PricingType =
  | 'fixed_per_creative'
  | 'hourly'
  | 'percentage_of_spend'
  | 'retainer'

export const DEFAULT_PRICING_TYPE: PricingType = 'fixed_per_creative'

const KNOWN: PricingType[] = ['fixed_per_creative', 'hourly', 'percentage_of_spend', 'retainer']

/** Narrows a free-text `services.pricing_type` to a known member. */
export function resolvePricingType(value: string | null | undefined): PricingType {
  return KNOWN.includes(value as PricingType) ? (value as PricingType) : DEFAULT_PRICING_TYPE
}

/** Tolerates the string state the form inputs hold. */
function num(value: number | string | null | undefined, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback
  const n = typeof value === 'number' ? value : parseFloat(value)
  return Number.isFinite(n) ? n : fallback
}

// ─── Unit price resolution ───────────────────────────────────────────────────

export interface ServiceLike {
  id: string
  pricing_type?: string | null
  default_price?: number | null
  default_currency?: string | null
}

export interface ClientPricingLike {
  client_id: string
  service_id: string
  price: number
  currency: string
  percentage_rate?: number | null
}

export interface ResolvedPrice {
  pricingType: PricingType
  /** Per unit / per hour, or the percentage rate for percentage_of_spend. */
  unitPrice: number
  currency: string
  /** True when the per-client Pricing Matrix supplied the price. */
  fromClientMatrix: boolean
}

/**
 * The per-client Pricing Matrix wins; otherwise the service default. Identical
 * precedence to the server's own lookup in serverFillTaskBilling, so an
 * auto-filled price and a form-computed one can never disagree.
 */
export function resolveUnitPrice(args: {
  services: ServiceLike[]
  clientPricings?: ClientPricingLike[]
  clientId: string | null | undefined
  serviceId: string | null | undefined
}): ResolvedPrice {
  const svc = args.services.find(s => s.id === args.serviceId)
  const cp = (args.clientPricings || []).find(
    p => p.client_id === args.clientId && p.service_id === args.serviceId,
  )
  return {
    pricingType: resolvePricingType(svc?.pricing_type),
    unitPrice: cp?.price ?? svc?.default_price ?? 0,
    currency: cp?.currency || svc?.default_currency || 'INR',
    fromClientMatrix: !!cp,
  }
}

// ─── The formula ─────────────────────────────────────────────────────────────

export interface AmountInputs {
  pricingType: PricingType
  unitPrice: number
  /** fixed_per_creative — number of creatives. */
  quantity?: number | string
  /** hourly — hours worked. */
  hours?: number | string
  /** percentage_of_spend — the client's ad spend. */
  spend?: number | string
  /**
   * percentage_of_spend only: the rate to apply, when the caller holds it in a
   * dedicated column (`client_service_pricing.percentage_rate`) rather than in
   * `price`. Falls back to unitPrice, which is what the task forms pass.
   */
  percentRate?: number | null
}

/** What the pricing matrix says this work is worth. Ignores retainer coverage. */
export function computeTaskAmount(i: AmountInputs): number {
  switch (i.pricingType) {
    case 'fixed_per_creative':
      return i.unitPrice * num(i.quantity, 1)
    case 'hourly':
      return i.unitPrice * num(i.hours, 1)
    case 'percentage_of_spend':
      return num(i.spend, 0) * ((i.percentRate ?? i.unitPrice) / 100)
    case 'retainer':
      return i.unitPrice // flat — not scaled by quantity
  }
}

/**
 * The value stored in `tasks.quantity`. Each pricing type measures its work in
 * its own unit, and the agreement progress engine consumes this column, so a
 * task with 4 creatives must store 4 — not 1.
 */
export function resolveTaskQuantity(i: {
  pricingType: PricingType
  quantity?: number | string
  hours?: number | string
  spend?: number | string
}): number {
  switch (i.pricingType) {
    case 'fixed_per_creative': return num(i.quantity, 1)
    case 'hourly':             return num(i.hours, 1)
    case 'percentage_of_spend':return num(i.spend, 0)
    case 'retainer':           return 1
  }
}

// ─── Coverage: what the client is actually charged ───────────────────────────

export interface CoverageState {
  /** An active retainer covers this client + service + date. */
  covered: boolean
  /** The user chose to bill this one on top of the retainer. */
  billAsExtra: boolean
}

/** True while the retainer absorbs the cost, so no client-price UI should show. */
export function isBillingSuppressed(c: CoverageState): boolean {
  return c.covered && !c.billAsExtra
}

/**
 * The amount to WRITE. Covered and not flagged extra bills at zero — the monthly
 * retainer is the invoice, and charging per task as well would bill the client
 * twice. Every save path must run its engine amount through this before
 * persisting; the server rejects a non-zero amount on a covered task.
 */
export function effectiveBillingAmount(amount: number, coverage: CoverageState): number {
  return isBillingSuppressed(coverage) ? 0 : amount
}
