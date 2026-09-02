import { round2 } from '@/lib/calculations/currency'

/**
 * Task Pricing Engine — the single source of truth for what a task bills.
 *
 * Pure and framework-free (no 'use client'/'use server') so the Add Task form,
 * the shared Edit Task modal, the bulk recalc tool, and server actions all run
 * the SAME arithmetic.
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
  /** Present on every real caller; optional so a pricing-only stub still fits. */
  name?: string | null
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

/** What the pricing matrix says this work is worth. */
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
 * its own unit, so a task with 4 creatives must store 4 — not 1.
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


/**
 * The per-unit rate a variant's percentage applies to.
 *
 * A variant ("Social Media size of the Big Deals flyer") is priced as a
 * percentage of its parent. The question is: a percentage of WHAT?
 *
 * `tasks.billing_amount` is the parent's TOTAL — unit price × its own
 * quantity. Taking the percentage of that made the variant's price depend on
 * how many creatives the PARENT happened to order, which is not a relationship
 * anybody agreed to: the same 15% variant of a ₹500 flyer cost ₹75 when the
 * parent ordered one and ₹150 when it ordered two, for identical work.
 *
 * The percentage is of the parent's RATE. So divide the parent's total back
 * down by its quantity first, and let the variant's own quantity scale it
 * afterwards — 15% of ₹500 is ₹75 a creative, whether the parent ordered one
 * or ten.
 */
export function parentUnitRate(parent: {
  billing_amount_inr?: number | null
  billing_amount?: number | null
  quantity?: number | string | null
}): number {
  const total = num(parent.billing_amount_inr ?? parent.billing_amount, 0)
  const qty = num(parent.quantity, 1)
  // A quantity of 0 would be a corrupt row; treating it as 1 returns the total
  // rather than Infinity, which is the least surprising wrong answer available.
  return qty > 0 ? total / qty : total
}

/**
 * What a variant of `parent` costs, at `percent` of the parent's rate, for
 * `quantity` units of the variant's own work.
 */
export function computeVariantAmount(i: {
  parent: { billing_amount_inr?: number | null; billing_amount?: number | null; quantity?: number | string | null }
  percent: number | string
  pricingType: PricingType
  quantity?: number | string
  hours?: number | string
  spend?: number | string
}): number {
  const share = num(i.percent, 0) / 100

  // percentage_of_spend is left on its previous formula deliberately.
  // `quantity` there stores the SPEND, not a count, so "the parent's rate per
  // unit" has no meaning — dividing the parent's fee by its spend gives a
  // fraction, not a price. No variant in production uses such a service, so
  // rather than invent semantics for a case nobody has, this preserves exactly
  // what it did before and leaves the question open for whoever needs it.
  if (i.pricingType === 'percentage_of_spend') {
    const parentTotal = num(i.parent.billing_amount_inr ?? i.parent.billing_amount, 0)
    return round2(parentTotal * share) * num(i.spend, 0)
  }

  // Round the per-unit rate before scaling, so the variant's own rate is a real
  // money figure and qty × rate is reproducible by hand from the invoice.
  const unit = round2(parentUnitRate(i.parent) * share)
  return computeTaskAmount({ ...i, pricingType: i.pricingType, unitPrice: unit })
}

/**
 * Re-scale an existing amount when only the QUANTITY changed.
 *
 * The hole this closes: an editor without pricing visibility may change a
 * task's quantity, and their save deliberately omits every billing field —
 * they must not be able to send an amount they cannot see. The server then
 * wrote the new quantity and left the old amount, so a one-creative task
 * became a two-creative task still billed for one. Three tasks in production
 * reached that state; two were invoiced before anyone noticed.
 *
 * Scaling by the ratio, rather than re-reading the pricing matrix, is the
 * conservative repair: it preserves whatever rate the task was actually on —
 * matrix, negotiated, or a variant's percentage — and only ever answers the
 * question that was asked, "how much for this many". Re-pricing from the
 * matrix would silently overwrite an agreed amount the moment someone touched
 * the quantity.
 *
 * Returns null when there is nothing to do, so the caller can leave the column
 * out of the update entirely rather than writing an unchanged value.
 */
export function rescaleAmountForQuantity(i: {
  currentAmount: number | null | undefined
  currentQuantity: number | null | undefined
  nextQuantity: number | null | undefined
}): number | null {
  const amount = num(i.currentAmount, NaN)
  const from = num(i.currentQuantity, NaN)
  const to = num(i.nextQuantity, NaN)
  if (!Number.isFinite(amount) || !Number.isFinite(from) || !Number.isFinite(to)) return null
  // A zero "from" carries no rate to preserve — there is nothing to scale.
  if (from <= 0 || to < 0) return null
  if (from === to) return null
  return round2(amount * (to / from))
}
