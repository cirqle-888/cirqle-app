import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { rateLabel } from './format'

describe('rateLabel — per-unit bases', () => {
  it('reads as count × rate', () => {
    expect(rateLabel({ basis: 'entries', basisAmountInr: 142, percent: null, fixedAmountInr: 5 }))
      .toBe('142 entries × ₹5')
  })

  it('says "entry" for exactly one', () => {
    expect(rateLabel({ basis: 'entries', basisAmountInr: 1, percent: null, fixedAmountInr: 5 }))
      .toBe('1 entry × ₹5')
  })

  it('still explains itself at zero', () => {
    expect(rateLabel({ basis: 'entries', basisAmountInr: 0, percent: null, fixedAmountInr: 5 }))
      .toBe('0 entries × ₹5')
  })

  // The count column is numeric(14,2) and the rate may be missing on a
  // mis-configured rule; neither may render as "142.00" or "NaN".
  it('renders a whole count and a missing rate without decimals or NaN', () => {
    expect(rateLabel({ basis: 'entries', basisAmountInr: 142.0, percent: null, fixedAmountInr: null }))
      .toBe('142 entries × ₹0')
  })

  it('groups large counts on the Indian numbering system', () => {
    expect(rateLabel({ basis: 'entries', basisAmountInr: 100000, percent: null, fixedAmountInr: 5 }))
      .toBe('1,00,000 entries × ₹5')
  })
})

describe('rateLabel — money bases still read as they did', () => {
  it.each([
    [{ basis: 'collected', basisAmountInr: 11750, percent: 2 }, '2% of collections'],
    [{ basis: 'billing',   basisAmountInr: 1600,  percent: 3 }, '3% of billing'],
    [{ basis: 'profit',    basisAmountInr: 500,   percent: 10 }, '10% of profit'],
    [{ basis: 'fixed',     basisAmountInr: 0,     percent: null }, 'fixed amount'],
    [{ basis: 'mixed',     basisAmountInr: 0,     percent: null }, 'mixed rates'],
  ])('%o → %s', (award, expected) => {
    expect(rateLabel(award as Parameters<typeof rateLabel>[0])).toBe(expected)
  })

  it('falls back to the raw basis rather than an empty string', () => {
    expect(rateLabel({ basis: 'something_new', basisAmountInr: 0, percent: null }))
      .toBe('something_new')
  })
})

/**
 * Three screens each grew their own basis→label map and drifted apart — only
 * one printed the rate, and it printed the raw basis key. This keeps them
 * merged: a payslip and a payroll card must say the same sentence.
 */
describe('rateLabel is the only implementation', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap(name => {
      const full = join(dir, name)
      return statSync(full).isDirectory() ? walk(full)
        : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
    })

  it('no file under src/app defines its own basis→label map', () => {
    const offenders = walk('src/app').filter(f =>
      /\b(BASIS_LABEL|BASIS_NOUN)\s*(:|=)/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
