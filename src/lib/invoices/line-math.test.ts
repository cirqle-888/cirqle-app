import { describe, it, expect } from 'vitest'
import { unitPriceOf, hasInconsistentUnitPrice } from './line-math'

describe('unitPriceOf', () => {
  it('divides the total by the quantity', () => {
    expect(unitPriceOf({ quantity: 2, unit_price: 300, total: 600 })).toBe(300)
  })

  it('ignores a stored unit_price that contradicts the total', () => {
    // The reported row: stored as 2 × 600 with a total of 600, which printed
    // "2 × ₹600.00 = ₹600.00". The honest reading is ₹300 a unit.
    expect(unitPriceOf({ quantity: 2, unit_price: 600, total: 600 })).toBe(300)
    expect(unitPriceOf({ quantity: 4, unit_price: 1000, total: 1000 })).toBe(250)
  })

  it('falls back to the stored rate when there is no usable total', () => {
    // Pricing stripped for this viewer, or a malformed row.
    expect(unitPriceOf({ quantity: 2, unit_price: 300, total: null })).toBe(300)
    expect(unitPriceOf({ quantity: 0, unit_price: 300, total: 600 })).toBe(300)
  })

  it('returns null rather than zero when nothing is known', () => {
    // Zero is a price. Null is "not shown" — the caller prints a dash. Printing
    // ₹0.00 on a client's invoice because a field was hidden would be a lie.
    expect(unitPriceOf({ quantity: 2, unit_price: null, total: null })).toBeNull()
    expect(unitPriceOf(null)).toBeNull()
    expect(unitPriceOf({})).toBeNull()
  })

  it('keeps a real zero', () => {
    expect(unitPriceOf({ quantity: 1, unit_price: 0, total: 0 })).toBe(0)
  })

  it('handles a quantity of one', () => {
    expect(unitPriceOf({ quantity: 1, unit_price: 500, total: 500 })).toBe(500)
  })

  it('does not round — the caller formats', () => {
    // ₹2,300 over 12 is 191.666…; rounding here would bake the drift in twice.
    expect(unitPriceOf({ quantity: 12, unit_price: 191.67, total: 2300 })).toBeCloseTo(191.6667, 4)
  })
})

describe('hasInconsistentUnitPrice', () => {
  it('flags a genuine contradiction', () => {
    expect(hasInconsistentUnitPrice({ quantity: 2, unit_price: 600, total: 600 })).toBe(true)
  })

  it('tolerates paise drift from a rounded rate', () => {
    // 8 × 18.86 = 150.88 against a total of 150.90. The writer was correct;
    // two decimal places simply cannot express 150.9/8.
    expect(hasInconsistentUnitPrice({ quantity: 8, unit_price: 18.86, total: 150.9 })).toBe(false)
    expect(hasInconsistentUnitPrice({ quantity: 12, unit_price: 191.67, total: 2300 })).toBe(false)
  })

  it('says nothing when a field is missing', () => {
    expect(hasInconsistentUnitPrice({ quantity: 2, unit_price: null, total: 600 })).toBe(false)
  })
})
