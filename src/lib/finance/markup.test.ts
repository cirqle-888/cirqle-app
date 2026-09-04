import { describe, it, expect } from 'vitest'
import { computeMarkup, markupLabel, isMarkupType } from './markup'

describe('computeMarkup', () => {
  it('leaves the cost untouched when no cushion is set', () => {
    expect(computeMarkup(2330, 'none', 0)).toEqual({ billed: 2330, markupAmount: 0 })
    // A value left behind from a previous choice must not apply once the type
    // is 'none' — the type is the switch, not the value.
    expect(computeMarkup(2330, 'none', 15)).toEqual({ billed: 2330, markupAmount: 0 })
  })

  it('adds a percentage cushion', () => {
    expect(computeMarkup(2330, 'percentage', 15)).toEqual({ billed: 2679.5, markupAmount: 349.5 })
    expect(computeMarkup(1000, 'percentage', 20)).toEqual({ billed: 1200, markupAmount: 200 })
  })

  it('adds a flat service charge', () => {
    expect(computeMarkup(2330, 'fixed', 200)).toEqual({ billed: 2530, markupAmount: 200 })
  })

  it('rounds the way the ledger does, not the naive way', () => {
    // 20.10 × 5% = 1.005 exactly. Naive Math.round(1.005*100)/100 gives 1.00
    // because the float lands at 100.49999999999999; round2 gives 1.01.
    expect(computeMarkup(20.10, 'percentage', 5).markupAmount).toBe(1.01)
  })

  it('treats a blank or unparseable value as no cushion', () => {
    expect(computeMarkup(500, 'percentage', null)).toEqual({ billed: 500, markupAmount: 0 })
    expect(computeMarkup(500, 'fixed', undefined)).toEqual({ billed: 500, markupAmount: 0 })
    expect(computeMarkup(500, 'percentage', NaN)).toEqual({ billed: 500, markupAmount: 0 })
  })

  it('handles an unknown type as none rather than throwing', () => {
    // markup_type arrives from a DB column; a value written before the CHECK
    // constraint, or by a future migration, must not break an invoice.
    expect(computeMarkup(500, 'something-else', 10)).toEqual({ billed: 500, markupAmount: 0 })
    expect(computeMarkup(500, null, 10)).toEqual({ billed: 500, markupAmount: 0 })
  })

  it('supports a negative cushion (a discount passed on to the client)', () => {
    expect(computeMarkup(1000, 'fixed', -100)).toEqual({ billed: 900, markupAmount: -100 })
  })
})

describe('markupLabel', () => {
  it('describes a configured cushion', () => {
    expect(markupLabel('percentage', 15)).toBe('15%')
    expect(markupLabel('fixed', 200)).toBe('₹200')
    expect(markupLabel('fixed', 200, '$')).toBe('$200')
  })

  it('is null when nothing is set, so callers can hide the badge', () => {
    expect(markupLabel('none', 0)).toBeNull()
    expect(markupLabel('percentage', 0)).toBeNull()
    expect(markupLabel(null, 15)).toBeNull()
  })
})

describe('isMarkupType', () => {
  it('accepts the three stored values and rejects anything else', () => {
    expect(isMarkupType('none')).toBe(true)
    expect(isMarkupType('percentage')).toBe(true)
    expect(isMarkupType('fixed')).toBe(true)
    expect(isMarkupType('percent')).toBe(false)
    expect(isMarkupType(null)).toBe(false)
  })
})
