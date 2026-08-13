import { describe, it, expect } from 'vitest'
import {
  computeTaskAmount, resolveTaskQuantity, resolveUnitPrice, resolvePricingType,
  type ServiceLike, type ClientPricingLike,
} from './pricing'

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
