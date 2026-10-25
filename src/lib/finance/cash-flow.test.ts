import { describe, it, expect } from 'vitest'
import { cashFlowTotals, cashFlowContribution, operatingRows } from './cash-flow'

describe('cashFlowTotals', () => {
  it('sums ordinary income and expense', () => {
    expect(cashFlowTotals([
      { type: 'inflow', amount_inr: 1500 },
      { type: 'outflow', amount_inr: 371 },
    ])).toEqual({ inflow: 1500, outflow: 371, net: 1129 })
  })

  it('never counts either leg of an internal transfer', () => {
    const totals = cashFlowTotals([
      { type: 'inflow', amount_inr: 1200 },
      { type: 'outflow', amount_inr: 50000, transfer_ref: 't1' },
      { type: 'inflow', amount_inr: 50000, transfer_ref: 't1' },
    ])
    expect(totals).toEqual({ inflow: 1200, outflow: 0, net: 1200 })
  })

  it('nets a returned salary against outflow instead of counting it as income', () => {
    const totals = cashFlowTotals([
      { type: 'outflow', amount_inr: 5353 },                      // salary NEFT
      { type: 'inflow', amount_inr: 5353, reversal_of: 'sal-1' }, // bounced back
      { type: 'inflow', amount_inr: 1000 },
    ])
    expect(totals.inflow).toBe(1000)
    expect(totals.outflow).toBe(0)
    expect(totals.net).toBe(1000)
  })

  it('nets a refunded receipt against inflow', () => {
    const totals = cashFlowTotals([
      { type: 'inflow', amount_inr: 2000 },
      { type: 'outflow', amount_inr: 2000, reversal_of: 'rcpt-1' },
    ])
    expect(totals).toEqual({ inflow: 0, outflow: 0, net: 0 })
  })

  it('reads magnitudes, whatever sign a row was stored with', () => {
    expect(cashFlowContribution({ type: 'outflow', amount_inr: -300 })).toEqual({ inflow: 0, outflow: 300 })
  })
})

describe('operatingRows', () => {
  it('drops credit, capital and drawings rows but keeps uncategorised ones', () => {
    const rows = [
      { type: 'outflow', amount_inr: 100000, category: { statement_section: 'financial' } },
      { type: 'inflow', amount_inr: 50000, category: { statement_section: 'financial' } },
      { type: 'outflow', amount_inr: 20000, category: { statement_section: 'excluded' } },
      { type: 'inflow', amount_inr: 32250, category: { statement_section: 'revenue' } },
      { type: 'outflow', amount_inr: 5000, category: null },
    ]
    expect(cashFlowTotals(operatingRows(rows))).toEqual({ inflow: 32250, outflow: 5000, net: 27250 })
  })
})
