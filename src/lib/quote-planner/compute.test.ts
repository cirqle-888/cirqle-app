import { describe, it, expect } from 'vitest'
import { planQuote, type PlanRefs } from './compute'
import type { PlanLine, QuotePlan, ShareOverride } from './types'
import type { ContributionGroup, Parameter } from '@/types'

/**
 * These tests hold two promises.
 *
 * The first is ARITHMETIC: a quote's pool is its billing times the commission
 * percentage, and a rating multiplies what an employee takes. Anyone can check
 * those by hand, and if the planner ever disagrees with a hand calculation the
 * quote is worthless.
 *
 * The second is SEPARATION: measured figures and apportioned ones never end up
 * in the same field. A margin that silently mixes "what this deal earns" with
 * "this deal's share of the rent" is a number nobody can argue with, which is
 * exactly the problem.
 */

const GROUP_DESIGN: ContributionGroup = {
  id: 'g-design', name: 'Flyer Design Group', weight: 50, is_active: true, display_order: 1,
}
const GROUP_PRODUCTS: ContributionGroup = {
  id: 'g-products', name: 'Flyer Products Group', weight: 50, is_active: true, display_order: 2,
}
const P_DESIGN: Parameter = {
  id: 'p-design', group_id: 'g-design', name: 'Design', weight: 1, is_active: true, display_order: 1,
}
const P_PRODUCTS: Parameter = {
  id: 'p-products', group_id: 'g-products', name: 'Products', weight: 1, is_active: true, display_order: 1,
}

const REFS: PlanRefs = {
  employees: [
    { id: 'e1', cqid: 'CQID001', performanceRating: 100 },
    { id: 'e2', cqid: 'CQID004', performanceRating: 100 },
  ],
  groups: [GROUP_DESIGN, GROUP_PRODUCTS],
  parameters: [P_DESIGN, P_PRODUCTS],
  toolsByService: {},
  rateToInr: 1,
}

const LINE: PlanLine = {
  id: 'l1', serviceId: 'svc-flyer', monthlyQuantity: 1, unitPrice: 25000,
  currency: 'INR', matrixUnitPrice: 25000, commissionPct: 50, displayOrder: 0,
}

function plan(over: Partial<QuotePlan> = {}): QuotePlan {
  return {
    id: 'plan-1', clientId: 'c1', name: 'Sea Star retainer', status: 'draft',
    currency: 'INR', termMonths: 12, lines: [LINE],
    shares: [], ratings: {}, costs: [], includeOverheads: false,
    quotationId: null, notes: '', ...over,
  }
}

const share = (employeeId: string, parameterId: string, sharePct: number): ShareOverride =>
  ({ lineId: 'l1', employeeId, parameterId, sharePct })

describe('the quote itself', () => {
  it('totals a monthly line over the term', () => {
    const r = planQuote(plan(), REFS)
    expect(r.monthlyQuotedInr).toBe(25000)
    expect(r.termQuotedInr).toBe(300000)
    expect(r.termMonths).toBe(12)
  })

  it('multiplies by the monthly count', () => {
    const r = planQuote(plan({ lines: [{ ...LINE, monthlyQuantity: 4 }] }), REFS)
    expect(r.monthlyQuotedInr).toBe(100000)
  })

  it('sizes the pool as billing × commission%, checkable by hand', () => {
    const r = planQuote(plan({ shares: [share('e1', 'p-design', 100)] }), REFS)
    expect(r.lines[0].employeePoolInr).toBe(12500)   // 25,000 × 50%
  })

  it('follows a commission override', () => {
    const r = planQuote(
      plan({ lines: [{ ...LINE, commissionPct: 40 }], shares: [share('e1', 'p-design', 100)] }),
      REFS,
    )
    expect(r.lines[0].employeePoolInr).toBe(10000)
  })

  it('reports a zero term as zero rather than NaN', () => {
    const r = planQuote(plan({ termMonths: 0 }), REFS)
    expect(r.termQuotedInr).toBe(0)
    expect(r.notes.join(' ')).toMatch(/zero months/)
  })
})

describe('who earns what', () => {
  it('splits the pool the way the shares say', () => {
    const r = planQuote(plan({
      shares: [share('e1', 'p-design', 60), share('e2', 'p-design', 40)],
    }), REFS)
    const [a, b] = r.lines[0].earnings.sort((x, y) => y.monthlyInr - x.monthlyInr)
    expect(a.monthlyInr).toBe(7500)   // 60% of 12,500
    expect(b.monthlyInr).toBe(5000)   // 40% of 12,500
  })

  it('moving one share moves only that employee', () => {
    const before = planQuote(plan({
      shares: [share('e1', 'p-design', 50), share('e2', 'p-design', 50)],
    }), REFS)
    const after = planQuote(plan({
      shares: [share('e1', 'p-design', 80), share('e2', 'p-design', 20)],
    }), REFS)
    const sum = (r: typeof before) => r.lines[0].earnings.reduce((s, e) => s + e.monthlyInr, 0)
    // The pool is unchanged; only its division moved.
    expect(sum(before)).toBe(sum(after))
    expect(after.lines[0].earnings.find(e => e.employeeCqid === 'CQID001')!.monthlyInr).toBe(10000)
  })

  it('cuts earnings by the planned performance rating', () => {
    // The lever the whole question rests on: "if I change performance %".
    const full = planQuote(plan({ shares: [share('e1', 'p-design', 100)] }), REFS)
    const eighty = planQuote(plan({
      shares: [share('e1', 'p-design', 100)], ratings: { e1: 80 },
    }), REFS)
    expect(full.lines[0].earnings[0].monthlyInr).toBe(12500)
    expect(eighty.lines[0].earnings[0].monthlyInr).toBe(10000)   // exactly 80%
    expect(eighty.lines[0].earnings[0].ratingPct).toBe(80)
  })

  it('leaves the pool intact when a rating is cut — the saving is the margin', () => {
    const r = planQuote(plan({
      shares: [share('e1', 'p-design', 100)], ratings: { e1: 50 },
    }), REFS)
    expect(r.lines[0].remainingPoolInr).toBe(12500)
    expect(r.lines[0].earnedInr).toBe(6250)
  })

  it('weights two groups against each other the way the engine does', () => {
    // e1 owns Design (weight 50), e2 owns Products (weight 50) → half each.
    const r = planQuote(plan({
      shares: [share('e1', 'p-design', 100), share('e2', 'p-products', 100)],
    }), REFS)
    const a = r.lines[0].earnings.find(e => e.employeeCqid === 'CQID001')!
    const b = r.lines[0].earnings.find(e => e.employeeCqid === 'CQID004')!
    expect(a.monthlyInr).toBe(6250)
    expect(b.monthlyInr).toBe(6250)
  })

  it('sums an employee across lines over the term', () => {
    const second: PlanLine = { ...LINE, id: 'l2', unitPrice: 10000, displayOrder: 1 }
    const r = planQuote(plan({
      lines: [LINE, second],
      shares: [
        share('e1', 'p-design', 100),
        { lineId: 'l2', employeeId: 'e1', parameterId: 'p-design', sharePct: 100 },
      ],
    }), REFS)
    const e1 = r.earnings.find(e => e.employeeCqid === 'CQID001')!
    expect(e1.monthlyInr).toBe(17500)          // 12,500 + 5,000
    expect(e1.termInr).toBe(210000)            // × 12
  })

  it('never carries an employee name — only the CQID', () => {
    const r = planQuote(plan({ shares: [share('e1', 'p-design', 100)] }), REFS)
    const json = JSON.stringify(r)
    expect(json).toContain('CQID001')
    expect(Object.keys(r.earnings[0])).not.toContain('employeeName')
  })

  it('shows the pool but assigns nobody when no shares are set', () => {
    const r = planQuote(plan(), REFS)
    expect(r.lines[0].employeePoolInr).toBe(12500)
    expect(r.lines[0].earnings).toEqual([])
    expect(r.notes.join(' ')).toMatch(/no employee shares/)
  })
})

describe('currency', () => {
  it('converts a foreign quote to INR and keeps both', () => {
    const r = planQuote(
      plan({ currency: 'AED', lines: [{ ...LINE, unitPrice: 1000, currency: 'AED' }] }),
      { ...REFS, rateToInr: 23.5 },
    )
    expect(r.monthlyQuotedInr).toBe(23500)
    expect(r.monthlyQuoted).toBe(1000)
    expect(r.rateToInr).toBe(23.5)
  })

  it('sizes the pool from the INR value, not the foreign one', () => {
    const r = planQuote(
      plan({
        currency: 'AED', lines: [{ ...LINE, unitPrice: 1000, currency: 'AED' }],
        shares: [share('e1', 'p-design', 100)],
      }),
      { ...REFS, rateToInr: 23.5 },
    )
    expect(r.lines[0].employeePoolInr).toBe(11750)   // 23,500 × 50%
  })

  it('falls back to 1 for a nonsense rate rather than producing zero', () => {
    const r = planQuote(plan(), { ...REFS, rateToInr: 0 })
    expect(r.rateToInr).toBe(1)
    expect(r.monthlyQuotedInr).toBe(25000)
  })
})

describe('margin', () => {
  it('deal margin is quote − earnings − planned costs', () => {
    const r = planQuote(plan({ shares: [share('e1', 'p-design', 100)] }), REFS)
    expect(r.margin.quotedInr).toBe(300000)
    expect(r.margin.earningsInr).toBe(150000)
    expect(r.margin.dealMarginInr).toBe(150000)
    expect(r.margin.dealMarginPct).toBe(50)
  })

  it('subtracts a monthly planned cost across the term, and a one-off once', () => {
    const r = planQuote(plan({
      shares: [share('e1', 'p-design', 100)],
      costs: [
        { id: 'c1', label: 'Printing', amount: 1000, currency: 'INR', cadence: 'monthly' },
        { id: 'c2', label: 'Shoot', amount: 5000, currency: 'INR', cadence: 'once' },
      ],
    }), REFS)
    expect(r.margin.plannedCostsInr).toBe(17000)   // 1,000×12 + 5,000
    expect(r.margin.dealMarginInr).toBe(133000)
  })

  it('equals the deal margin exactly when overheads are off', () => {
    // The reconciliation the plan promises: zero allocation changes nothing.
    const r = planQuote(plan({ shares: [share('e1', 'p-design', 100)] }), REFS)
    expect(r.margin.operatingResultInr).toBe(r.margin.dealMarginInr)
    expect(r.margin.overheadsIncluded).toBe(false)
    expect(r.margin.allocatedSalariesInr).toBe(0)
    expect(r.margin.allocatedExpensesInr).toBe(0)
  })

  it('keeps allocated figures in their own fields, never folded into measured', () => {
    const r = planQuote(
      plan({ shares: [share('e1', 'p-design', 100)], includeOverheads: true }),
      {
        ...REFS,
        overheads: {
          monthlyBaseSalariesInr: 100000,
          monthlyExpensesInr: 50000,
          companyMonthlyBillingInr: 100000,   // this deal is 25% of billing
        },
      },
    )
    // Measured half is untouched by the allocation.
    expect(r.margin.dealMarginInr).toBe(150000)
    // 25% of (100,000 × 12) and 25% of (50,000 × 12).
    expect(r.margin.allocatedSalariesInr).toBe(300000)
    expect(r.margin.allocatedExpensesInr).toBe(150000)
    expect(r.margin.operatingResultInr).toBe(-300000)
    expect(r.margin.overheadsIncluded).toBe(true)
  })

  it('says so when overheads were asked for but no figures were supplied', () => {
    const r = planQuote(plan({ includeOverheads: true }), REFS)
    expect(r.margin.overheadsIncluded).toBe(false)
    expect(r.notes.join(' ')).toMatch(/no company figures/)
  })
})

describe('against the rack rate', () => {
  it('reports a discount as negative and a premium as positive', () => {
    const under = planQuote(plan({ lines: [{ ...LINE, unitPrice: 20000 }] }), REFS)
    const over = planQuote(plan({ lines: [{ ...LINE, unitPrice: 30000 }] }), REFS)
    expect(under.lines[0].vsMatrixInr).toBe(-5000)
    expect(over.lines[0].vsMatrixInr).toBe(5000)
  })

  it('is null when there is no matrix price to compare against', () => {
    const r = planQuote(plan({ lines: [{ ...LINE, matrixUnitPrice: null }] }), REFS)
    expect(r.lines[0].vsMatrixInr).toBeNull()
  })
})
