import { describe, it, expect } from 'vitest'
import { computeDeltas } from './adjustments'

const m = (o: Record<string, number>) => new Map(Object.entries(o))

describe('computeDeltas — what a closed month owes (or overpaid)', () => {
  it('finds nothing when the books balance', () => {
    expect(computeDeltas(m({ e1: 5000, e2: 3000 }), m({ e1: 5000, e2: 3000 }), 6, 2026)).toEqual([])
  })

  it('detects a shortfall when a task was entered after the month closed', () => {
    // The core workflow: a July task is remembered in August, so July's
    // earnings are now higher than July's payslip paid.
    const out = computeDeltas(m({ e1: 5000 }), m({ e1: 6200 }), 7, 2026)
    expect(out).toEqual([{
      employeeId: 'e1', sourceMonth: 7, sourceYear: 2026,
      amountInr: 1200, currentEarningsInr: 6200, paidCommissionInr: 5000,
    }])
  })

  it('detects an overpayment as a NEGATIVE delta rather than dropping it', () => {
    // A deleted or re-priced task can leave a closed month overpaid. Silently
    // ignoring that would make payroll disagree with the ledger.
    const out = computeDeltas(m({ e1: 5000 }), m({ e1: 4200 }), 7, 2026)
    expect(out[0].amountInr).toBe(-800)
  })

  it('treats an employee whose earnings vanished entirely as fully overpaid', () => {
    const out = computeDeltas(m({ e1: 900 }), m({}), 7, 2026)
    expect(out[0].amountInr).toBe(-900)
  })

  it('ignores sub-rupee rounding drift', () => {
    expect(computeDeltas(m({ e1: 5000 }), m({ e1: 5000.4 }), 7, 2026)).toEqual([])
    // …but not a whole rupee.
    expect(computeDeltas(m({ e1: 5000 }), m({ e1: 5001 }), 7, 2026)).toHaveLength(1)
  })

  it('NEVER adjusts an employee who was not paid for that month', () => {
    // No paid baseline means nothing to reconcile against — their earnings
    // belong to whichever open month settles them, not to a correction.
    const out = computeDeltas(m({ e1: 5000 }), m({ e1: 5000, newHire: 4000 }), 7, 2026)
    expect(out).toEqual([])
  })

  it('reports each affected employee separately', () => {
    const out = computeDeltas(
      m({ e1: 5000, e2: 3000, e3: 1000 }),
      m({ e1: 6000, e2: 3000, e3: 400 }),
      7, 2026,
    )
    expect(out.map(a => [a.employeeId, a.amountInr])).toEqual([['e1', 1000], ['e3', -600]])
  })

  it('rounds to paise', () => {
    expect(computeDeltas(m({ e1: 0 }), m({ e1: 1200.005 }), 7, 2026)[0].amountInr).toBe(1200.01)
  })
})
