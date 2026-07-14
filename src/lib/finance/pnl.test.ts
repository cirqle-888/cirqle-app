import { describe, it, expect } from 'vitest'
import { buildCompanyPnl, monthRange, monthOf } from './pnl'
import { computeCompanyOpsStrip } from './kpis'
import { buildClientProfitability } from './client-profitability'
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

describe('monthOf / monthRange', () => {
  it('extracts month and builds inclusive ranges across years', () => {
    expect(monthOf('2026-07-14')).toBe('2026-07')
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
  })
})

describe('buildCompanyPnl', () => {
  it('groups by month and account with section subtotals', () => {
    const pnl = buildCompanyPnl([
      line({ amountInr: -10000, accountCode: 'opex.salaries', categoryName: 'Salary' }),
      line({ amountInr: -5000, accountCode: 'opex.salaries', categoryName: 'Salary', date: '2026-06-05' }),
      line({ amountInr: -2000, accountCode: 'opex.rent' }),
      line({ amountInr: -1180, section: 'cogs', accountCode: 'cogs.ad_spend', categoryName: 'Online Spend' }),
      line({ amountInr: 500, section: 'revenue', accountCode: 'revenue.other', categoryName: 'Other Income' }),
    ])
    expect(pnl.months).toEqual(['2026-06', '2026-07'])
    const opex = pnl.sections.find(s => s.section === 'opex')!
    const salaries = opex.rows.find(r => r.accountCode === 'opex.salaries')!
    expect(salaries.byMonth['2026-07']).toBe(-10000)
    expect(salaries.byMonth['2026-06']).toBe(-5000)
    expect(salaries.totalInr).toBe(-15000)
    expect(opex.byMonth['2026-07']).toBe(-12000)
    // net = revenue + cogs + opex (signed)
    expect(pnl.netByMonth['2026-07']).toBe(500 - 2000 - 10000 - 1180)
    expect(pnl.netTotalInr).toBe(500 - 2000 - 15000 - 1180)
  })

  it('excludes financial/excluded sections and transfers', () => {
    const pnl = buildCompanyPnl([
      line({ amountInr: -9999, section: 'excluded', accountCode: 'excluded.owner_drawings' }),
      line({ amountInr: -500, section: 'financial', accountCode: 'financial.credit_given' }),
      line({ amountInr: -100, isTransfer: true }),
      line({ amountInr: -1000 }),
    ])
    expect(pnl.netTotalInr).toBe(-1000)
    expect(pnl.sections.flatMap(s => s.rows).map(r => r.accountCode)).toEqual(['opex.rent'])
  })

  it('buckets unmapped categories as unclassified instead of dropping them', () => {
    const pnl = buildCompanyPnl([
      line({ section: null, accountCode: null, categoryName: 'Mystery', amountInr: -700 }),
    ])
    const unc = pnl.sections.find(s => s.section === 'unclassified')!
    expect(unc.rows[0].accountCode).toBe('unclassified.Mystery')
    expect(unc.totalInr).toBe(-700)
  })

  it('computes burn rate over the trailing window, ignoring net-inflow months', () => {
    const pnl = buildCompanyPnl([
      line({ date: '2026-05-01', amountInr: -3000 }),
      line({ date: '2026-06-01', amountInr: -6000 }),
      line({ date: '2026-07-01', amountInr: 900, section: 'revenue', accountCode: 'revenue.other' }),
    ], { bankBalanceInr: 9000, burnWindow: 3 })
    // months: 05 (-3000), 06 (-6000), 07 (+900 → contributes 0)
    expect(pnl.burnRateInr).toBe(3000)
    expect(pnl.runwayMonths).toBe(3)
  })

  it('runway is null when burn is zero or balance unknown', () => {
    expect(buildCompanyPnl([], { bankBalanceInr: 5000 }).runwayMonths).toBeNull()
    expect(buildCompanyPnl([line({})], {}).runwayMonths).toBeNull()
  })
})

describe('computeCompanyOpsStrip', () => {
  it('splits the month spend by account and counts untriaged', () => {
    const strip = computeCompanyOpsStrip([
      line({ accountCode: 'opex.salaries', amountInr: -50000 }),
      line({ accountCode: 'opex.marketing', amountInr: -11800 }),
      line({ accountCode: 'opex.software', amountInr: -2000 }),
      line({ accountCode: 'opex.rent', amountInr: -8000 }),
      line({ date: '2026-06-01', accountCode: 'opex.rent', amountInr: -8000 }),   // other month
      line({ scope: 'client', section: 'cogs', accountCode: 'cogs.ad_spend', amountInr: -5000 }),
      line({ scope: null, amountInr: -123 }),                                     // untriaged
      line({ scope: null, isTransfer: true, amountInr: -1 }),                     // transfer — not triage
    ], { month: '2026-07', bankBalanceInr: null })
    expect(strip.opexInr).toBe(50000 + 11800 + 2000 + 8000)
    expect(strip.payrollInr).toBe(50000)
    expect(strip.marketingInr).toBe(11800)
    expect(strip.softwareInr).toBe(2000)
    expect(strip.untriagedCount).toBe(1)
    expect(strip.runwayMonths).toBeNull()
  })
})

describe('buildClientProfitability', () => {
  it('computes contribution margin and totals', () => {
    const { rows, totals } = buildClientProfitability([
      { clientId: 'a', clientName: 'A', invoicedInr: 100000, collectedInr: 90000, directCostsInr: 20000, attributedLaborInr: 30000, markupRevenueInr: 5000 },
      { clientId: 'b', clientName: 'B', invoicedInr: 50000, collectedInr: 50000, directCostsInr: 40000, attributedLaborInr: 20000 },
    ])
    const a = rows.find(r => r.clientId === 'a')!
    expect(a.contributionMarginInr).toBe(100000 - 20000 - 30000 + 5000)
    expect(a.marginPct).toBe(55)
    const b = rows.find(r => r.clientId === 'b')!
    expect(b.contributionMarginInr).toBe(-10000)
    expect(rows[0].clientId).toBe('a')                    // sorted by margin desc
    expect(totals.invoicedInr).toBe(150000)
    expect(totals.contributionMarginInr).toBe(55000 - 10000)
    expect(totals.marginPct).toBe(30)
  })
  it('handles zero revenue without dividing by zero', () => {
    const { rows } = buildClientProfitability([
      { clientId: 'x', clientName: 'X', invoicedInr: 0, collectedInr: 0, directCostsInr: 100, attributedLaborInr: 0 },
    ])
    expect(rows[0].marginPct).toBe(0)
  })
})
