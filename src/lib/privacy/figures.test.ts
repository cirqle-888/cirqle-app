import { describe, it, expect } from 'vitest'
import { containsFigure, isBlurrable } from './figures'

/**
 * The asymmetry these tests encode: a false positive blurs a word, a false
 * negative puts somebody's salary on a projector. So the "should hide" cases
 * are exhaustive and the "should not hide" cases only cover text that would
 * make the app unusable if blurred.
 */

describe('containsFigure — money this app actually renders', () => {
  it('catches every currency symbol formatCurrency can emit', () => {
    for (const s of ['₹1,25,000', '$12.50', '£99', '€1.000', 'AED 400', 'SAR 250', 'QAR 99', 'Rs 1,299.50']) {
      expect(containsFigure(s), s).toBe(true)
    }
  })

  it('catches the compact forms the dashboard favours', () => {
    expect(containsFigure('₹1.5L')).toBe(true)
    expect(containsFigure('₹28.6K')).toBe(true)
    expect(containsFigure('₹2.4Cr')).toBe(true)
  })

  it('catches a negative balance', () => {
    expect(containsFigure('₹-4,500')).toBe(true)
  })

  it('catches an amount inside a sentence', () => {
    expect(containsFigure('Outstanding: ₹1,25,000 across 4 invoices')).toBe(true)
    expect(containsFigure("You've earned over Rs 50,000 in the last 6 months")).toBe(true)
  })

  it('catches a symbol separated from its number', () => {
    expect(containsFigure('₹ 1,25,000')).toBe(true)
    expect(containsFigure('AED  400')).toBe(true)
  })

  it('catches a grouped number with no symbol at all', () => {
    // Chart axes and table cells often drop the symbol.
    expect(containsFigure('1,25,000')).toBe(true)
    expect(containsFigure('12,500.00')).toBe(true)
  })

  it('catches a percentage — a contribution score is as private as its earnings', () => {
    expect(containsFigure('62.5%')).toBe(true)
    expect(containsFigure('100 %')).toBe(true)
  })
})

describe('containsFigure — what stays readable', () => {
  it('leaves ordinary words alone', () => {
    for (const s of ['Invoices', 'Sea Star Supermarket', 'Offer Flyer', 'Pending', '']) {
      expect(containsFigure(s), s).toBe(false)
    }
  })

  it('leaves a small bare number alone — a count is not a figure', () => {
    expect(containsFigure('44')).toBe(false)
    expect(containsFigure('Page 2')).toBe(false)
    expect(containsFigure('CQID001')).toBe(false)
  })

  it('leaves a year and a date alone', () => {
    expect(containsFigure('2026')).toBe(false)
    expect(containsFigure('13 Sep 2026')).toBe(false)
  })

  it('can be told to leave grouped numbers and percentages alone', () => {
    expect(containsFigure('1,25,000', { groupedNumbers: false })).toBe(false)
    expect(containsFigure('62.5%', { percentages: false })).toBe(false)
    // A currency amount is hidden whatever the options say.
    expect(containsFigure('₹1,25,000', { groupedNumbers: false, percentages: false })).toBe(true)
  })

  it('treats blank and whitespace as nothing to hide', () => {
    expect(containsFigure('   ')).toBe(false)
  })
})

describe('isBlurrable', () => {
  it('never blurs a field somebody is typing into', () => {
    // Blurring mid-edit makes the app unusable rather than discreet.
    expect(isBlurrable('INPUT', false)).toBe(false)
    expect(isBlurrable('TEXTAREA', false)).toBe(false)
    expect(isBlurrable('SELECT', false)).toBe(false)
  })

  it('blurs a leaf element that holds the text itself', () => {
    expect(isBlurrable('SPAN', false)).toBe(true)
    expect(isBlurrable('TD', false)).toBe(true)
    expect(isBlurrable('P', false)).toBe(true)
  })

  it('leaves containers alone, so a card keeps its labels', () => {
    expect(isBlurrable('DIV', true)).toBe(false)
  })

  it('is case-insensitive about the tag name', () => {
    expect(isBlurrable('input', false)).toBe(false)
  })
})

describe('containsFigure — the "Rs" over-match (regression)', () => {
  it('does not blur an ordinary word that happens to end in "rs"', () => {
    // "Rs" is a currency code, and case-insensitively it used to match the
    // tail of these words, blurring the labels a demo depends on.
    for (const s of ['Hours 150', 'Orders 12', 'Members 5', 'Users 3',
                     'Filters 2', 'Layers 22', 'Errors 0', 'Colours 4']) {
      expect(containsFigure(s), s).toBe(false)
    }
  })

  it('still catches Rs when it really is the currency', () => {
    expect(containsFigure('Rs 1,299')).toBe(true)
    expect(containsFigure('rs 500')).toBe(true)
    expect(containsFigure('Total: Rs 45')).toBe(true)
  })

  it('still catches the other codes, and not their word-tails', () => {
    expect(containsFigure('AED 400')).toBe(true)
    expect(containsFigure('USD 30')).toBe(true)
    // "…used 30" must not read as USD.
    expect(containsFigure('Refused 30')).toBe(false)
  })
})
