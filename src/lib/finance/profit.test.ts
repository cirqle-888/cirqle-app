import { describe, it, expect } from 'vitest'
import {
  composeProfit, expensesFromLines, monthBounds, DEFAULT_OVERHEAD_POLICY,
  type OverheadPolicy,
} from './profit'
import type { JournalLine } from './types'

let seq = 0
function line(over: Partial<JournalLine>): JournalLine {
  return {
    id: `l${++seq}`,
    date: '2026-07-10',
    scope: 'company',
    section: 'opex',
    accountCode: 'opex.rent',
    categoryId: 'c1',
    categoryName: 'Rent & Workspace',
    clientId: null,
    employeeId: null,
    bankAccountId: null,
    amountInr: -1000,
    description: null,
    isTransfer: false,
    ...over,
  }
}

describe('composeProfit', () => {
  it('subtracts contribution earnings, base salaries and expenses from revenue', () => {
    expect(composeProfit({
      revenueInr: 100_000, contributionInr: 40_000, baseSalariesInr: 20_000, expensesInr: 15_000,
    })).toBe(25_000)
  })

  it('goes negative in a loss month rather than clamping — the engine reports truth', () => {
    expect(composeProfit({
      revenueInr: 10_000, contributionInr: 8_000, baseSalariesInr: 5_000, expensesInr: 4_000,
    })).toBe(-7_000)
  })

  it('rounds to paise', () => {
    expect(composeProfit({
      revenueInr: 100.005, contributionInr: 0, baseSalariesInr: 0, expensesInr: 0,
    })).toBe(100.01)
  })
})

describe('expensesFromLines', () => {
  const policy = DEFAULT_OVERHEAD_POLICY

  it('sums outflow magnitudes in the included sections', () => {
    expect(expensesFromLines([
      line({ amountInr: -2000, accountCode: 'opex.rent' }),
      line({ amountInr: -1500, accountCode: 'opex.utilities' }),
      line({ amountInr: -500, section: 'cogs', accountCode: 'cogs.ad_spend' }),
    ], policy)).toBe(4000)
  })

  it('EXCLUDES opex.salaries by default — labour is already subtracted as contribution + base salaries', () => {
    expect(expensesFromLines([
      line({ amountInr: -2000, accountCode: 'opex.rent' }),
      line({ amountInr: -90_000, accountCode: 'opex.salaries' }),
    ], policy)).toBe(2000)
  })

  it('ignores sections outside the policy (financial, excluded, revenue)', () => {
    expect(expensesFromLines([
      line({ amountInr: -5000, section: 'financial', accountCode: 'financial.loan' }),
      line({ amountInr: -3000, section: 'excluded', accountCode: 'excluded.owner_drawings' }),
      line({ amountInr: 50_000, section: 'revenue', accountCode: 'revenue.services' }),
      line({ amountInr: -1000, accountCode: 'opex.rent' }),
    ], policy)).toBe(1000)
  })

  it('ignores unmapped categories (section null) and inflows in expense sections', () => {
    expect(expensesFromLines([
      line({ section: null, accountCode: null, amountInr: -9999 }),
      line({ amountInr: 400, accountCode: 'opex.rent' }), // refund
      line({ amountInr: -600, accountCode: 'opex.rent' }),
    ], policy)).toBe(600)
  })

  it('honours a custom policy that includes salaries', () => {
    const includeSalaries: OverheadPolicy = { ...DEFAULT_OVERHEAD_POLICY, excludeAccountCodes: [] }
    expect(expensesFromLines([
      line({ amountInr: -2000, accountCode: 'opex.rent' }),
      line({ amountInr: -8000, accountCode: 'opex.salaries' }),
    ], includeSalaries)).toBe(10_000)
  })
})

describe('monthBounds', () => {
  it('produces a half-open window matching the payroll task predicate', () => {
    expect(monthBounds(7, 2026)).toEqual({ start: '2026-07-01', nextStart: '2026-08-01' })
  })

  it('rolls over the year in December', () => {
    expect(monthBounds(12, 2026)).toEqual({ start: '2026-12-01', nextStart: '2027-01-01' })
  })
})
