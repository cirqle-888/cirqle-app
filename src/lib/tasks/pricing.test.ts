import { round2 } from '@/lib/calculations/currency'
import { describe, it, expect } from 'vitest'
import { computeTaskAmount, computeVariantAmount, parentUnitRate, rescaleAmountForQuantity, resolvePricingType, resolveTaskQuantity, resolveUnitPrice, type ClientPricingLike, type ServiceLike } from './pricing'

const services: ServiceLike[] = [
  { id: 'svc-poster', pricing_type: 'fixed_per_creative', default_price: 50, default_currency: 'AED' },
  { id: 'svc-hourly', pricing_type: 'hourly',             default_price: 100, default_currency: 'INR' },
  { id: 'svc-ads',    pricing_type: 'percentage_of_spend', default_price: 30, default_currency: 'AED' },
  { id: 'svc-ret',    pricing_type: 'retainer',           default_price: 400, default_currency: 'AED' },
  { id: 'svc-weird',  pricing_type: 'something_new',      default_price: 10, default_currency: 'INR' },
]

const clientPricings: ClientPricingLike[] = [
  { client_id: 'c-1', service_id: 'svc-poster', price: 20, currency: 'AED' },
]

describe('resolvePricingType', () => {
  it('falls back to fixed_per_creative for unknown or missing values', () => {
    expect(resolvePricingType('hourly')).toBe('hourly')
    expect(resolvePricingType('something_new')).toBe('fixed_per_creative')
    expect(resolvePricingType(null)).toBe('fixed_per_creative')
    expect(resolvePricingType(undefined)).toBe('fixed_per_creative')
  })
})

describe('resolveUnitPrice', () => {
  it('prefers the per-client matrix over the service default', () => {
    const r = resolveUnitPrice({ services, clientPricings, clientId: 'c-1', serviceId: 'svc-poster' })
    expect(r.unitPrice).toBe(20)
    expect(r.currency).toBe('AED')
    expect(r.fromClientMatrix).toBe(true)
  })

  it('falls back to the service default for a client with no matrix row', () => {
    const r = resolveUnitPrice({ services, clientPricings, clientId: 'c-2', serviceId: 'svc-poster' })
    expect(r.unitPrice).toBe(50)
    expect(r.fromClientMatrix).toBe(false)
  })

  it('returns a zero price rather than throwing for an unknown service', () => {
    const r = resolveUnitPrice({ services, clientPricings, clientId: 'c-1', serviceId: 'nope' })
    expect(r.unitPrice).toBe(0)
    expect(r.currency).toBe('INR')
  })
})

describe('computeTaskAmount', () => {
  it('multiplies unit price by creatives', () => {
    expect(computeTaskAmount({ pricingType: 'fixed_per_creative', unitPrice: 20, quantity: 4 })).toBe(80)
  })

  it('multiplies unit price by hours', () => {
    expect(computeTaskAmount({ pricingType: 'hourly', unitPrice: 100, hours: 2.5 })).toBe(250)
  })

  it('takes a percentage of spend', () => {
    expect(computeTaskAmount({ pricingType: 'percentage_of_spend', unitPrice: 30, spend: 1000 })).toBe(300)
  })

  it('uses an explicit percentRate when the caller stores it separately', () => {
    // The bulk recalc tool keeps the rate in percentage_rate, not price.
    expect(computeTaskAmount({
      pricingType: 'percentage_of_spend', unitPrice: 0, spend: 1000, percentRate: 30,
    })).toBe(300)
  })

  it('does NOT scale a retainer by quantity', () => {
    expect(computeTaskAmount({ pricingType: 'retainer', unitPrice: 400, quantity: 15 })).toBe(400)
  })

  it('accepts the string values the form inputs hold', () => {
    expect(computeTaskAmount({ pricingType: 'fixed_per_creative', unitPrice: 20, quantity: '3' })).toBe(60)
    expect(computeTaskAmount({ pricingType: 'hourly', unitPrice: 100, hours: '' })).toBe(100)
    expect(computeTaskAmount({ pricingType: 'fixed_per_creative', unitPrice: 20, quantity: 'abc' })).toBe(20)
  })
})

describe('resolveTaskQuantity', () => {
  it('stores each pricing type in its own unit', () => {
    expect(resolveTaskQuantity({ pricingType: 'fixed_per_creative', quantity: '4' })).toBe(4)
    expect(resolveTaskQuantity({ pricingType: 'hourly', hours: '2.5' })).toBe(2.5)
    expect(resolveTaskQuantity({ pricingType: 'percentage_of_spend', spend: '1000' })).toBe(1000)
    expect(resolveTaskQuantity({ pricingType: 'retainer', quantity: '15' })).toBe(1)
  })

  it('defaults to 1 creative / 1 hour and 0 spend', () => {
    expect(resolveTaskQuantity({ pricingType: 'fixed_per_creative' })).toBe(1)
    expect(resolveTaskQuantity({ pricingType: 'hourly' })).toBe(1)
    expect(resolveTaskQuantity({ pricingType: 'percentage_of_spend' })).toBe(0)
  })
})

describe('the Add Task and Edit Task paths agree', () => {
  const scenario = { services, clientPricings, clientId: 'c-1', serviceId: 'svc-poster' }

  it('produces an identical amount and quantity from identical inputs', () => {
    const { pricingType, unitPrice } = resolveUnitPrice(scenario)
    const amount = computeTaskAmount({ pricingType, unitPrice, quantity: '1' })
    const qty = resolveTaskQuantity({ pricingType, quantity: '1' })

    expect(amount).toBe(20)
    expect(qty).toBe(1)
  })
})

describe('parentUnitRate', () => {
  it('divides the parent total back down to a rate', () => {
    expect(parentUnitRate({ billing_amount_inr: 1000, quantity: 2 })).toBe(500)
  })

  it('a single-quantity parent is its own rate', () => {
    expect(parentUnitRate({ billing_amount_inr: 500, quantity: 1 })).toBe(500)
  })

  it('falls back to billing_amount when the INR column is absent', () => {
    expect(parentUnitRate({ billing_amount: 800, quantity: 4 })).toBe(200)
  })

  it('treats a zero or missing quantity as one rather than dividing by zero', () => {
    expect(parentUnitRate({ billing_amount_inr: 300, quantity: 0 })).toBe(300)
    expect(parentUnitRate({ billing_amount_inr: 300 })).toBe(300)
  })
})

describe('computeVariantAmount', () => {
  const parent = { billing_amount_inr: 1000, quantity: 2 }   // ₹500 a creative

  it('is a percentage of the parent RATE, not of the parent total', () => {
    // The reported case: 15% of a ₹500 flyer is ₹75 a creative. Against the
    // parent's ₹1,000 total it would have been ₹150 — doubling the variant
    // because the PARENT ordered two, for identical work.
    expect(computeVariantAmount({
      parent, percent: 15, pricingType: 'fixed_per_creative', quantity: 1,
    })).toBe(75)
  })

  it('scales by the VARIANT’s own quantity', () => {
    expect(computeVariantAmount({
      parent, percent: 15, pricingType: 'fixed_per_creative', quantity: 3,
    })).toBe(225)
  })

  it('does not change when the parent’s quantity changes', () => {
    // The property that was broken: the variant's rate is a fact about the
    // parent's price, not about how much of it was ordered.
    const one = { billing_amount_inr: 500, quantity: 1 }
    const ten = { billing_amount_inr: 5000, quantity: 10 }
    const of = (p: typeof one) => computeVariantAmount({
      parent: p, percent: 15, pricingType: 'fixed_per_creative', quantity: 1,
    })
    expect(of(one)).toBe(of(ten))
    expect(of(one)).toBe(75)
  })

  it('rounds the rate to paise before scaling, so qty x rate reproduces the total', () => {
    // 33% of ₹100 is ₹33 exactly; 33% of ₹1,000/3 is ₹110 a unit.
    const p = { billing_amount_inr: 1000, quantity: 3 }       // ₹333.333… a unit
    const unit = round2(parentUnitRate(p) * 0.33)
    expect(computeVariantAmount({ parent: p, percent: 33, pricingType: 'fixed_per_creative', quantity: 2 }))
      .toBe(unit * 2)
  })

  it('a retainer variant is flat, not scaled', () => {
    expect(computeVariantAmount({
      parent, percent: 20, pricingType: 'retainer', quantity: 5,
    })).toBe(100)
  })
})

describe('rescaleAmountForQuantity', () => {
  it('scales the amount with the quantity', () => {
    // The reported task: one creative at ₹500 became two, still billed ₹500.
    expect(rescaleAmountForQuantity({ currentAmount: 500, currentQuantity: 1, nextQuantity: 2 })).toBe(1000)
  })

  it('preserves a negotiated rate rather than re-pricing from the matrix', () => {
    // ₹400 for 2 is ₹200 a unit, whatever the matrix says. Three units is ₹600.
    expect(rescaleAmountForQuantity({ currentAmount: 400, currentQuantity: 2, nextQuantity: 3 })).toBe(600)
  })

  it('scales downward too', () => {
    expect(rescaleAmountForQuantity({ currentAmount: 1000, currentQuantity: 4, nextQuantity: 1 })).toBe(250)
  })

  it('returns null when nothing changed, so the caller writes nothing', () => {
    expect(rescaleAmountForQuantity({ currentAmount: 500, currentQuantity: 2, nextQuantity: 2 })).toBeNull()
  })

  it('refuses when there is no rate to preserve', () => {
    expect(rescaleAmountForQuantity({ currentAmount: 500, currentQuantity: 0, nextQuantity: 2 })).toBeNull()
    expect(rescaleAmountForQuantity({ currentAmount: null, currentQuantity: 1, nextQuantity: 2 })).toBeNull()
    expect(rescaleAmountForQuantity({ currentAmount: 500, currentQuantity: 1, nextQuantity: null })).toBeNull()
  })

  it('rounds to paise', () => {
    expect(rescaleAmountForQuantity({ currentAmount: 1000, currentQuantity: 3, nextQuantity: 1 })).toBe(333.33)
  })
})

describe('computeVariantAmount — percentage_of_spend is deliberately unchanged', () => {
  it('keeps the pre-existing formula rather than inventing a per-unit rate', () => {
    // `quantity` holds the SPEND for this pricing type, so "the parent's rate
    // per unit" is meaningless. No variant in production uses such a service;
    // this pins today's behaviour so a future change to it is a decision, not
    // an accident.
    const parent = { billing_amount_inr: 1000, quantity: 10000 }
    expect(computeVariantAmount({
      parent, percent: 15, pricingType: 'percentage_of_spend', spend: 2,
    })).toBe(300)   // round2(1000 * 0.15) * 2
  })
})
