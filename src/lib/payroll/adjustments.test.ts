import { describe, it, expect } from 'vitest'
import { computeDeltas, type AdjustmentTaskLine } from './adjustments'

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

describe('computeDeltas — the lineage behind a correction', () => {
  const task = (o: Partial<AdjustmentTaskLine> = {}): AdjustmentTaskLine => ({
    taskId: 't1', taskNumber: 1900, title: 'Logo Concept',
    taskDate: '2026-07-20', earningsInr: 291.2, ...o,
  })

  it('names the removed task that explains an overpayment', () => {
    const [adj] = computeDeltas(
      m({ e1: 2602 }), m({ e1: 2310.8 }), 7, 2026,
      new Map([['e1', [task({ taskId: 'live', taskNumber: 1902, earningsInr: 640 })]]]),
      new Map([['e1', [task({ deletedAt: '2026-09-01T16:26:00Z' })]]]),
    )
    expect(adj.amountInr).toBe(-291.2)
    expect(adj.lineage!.removedTasks).toHaveLength(1)
    expect(adj.lineage!.removedTasks[0].taskNumber).toBe(1900)
    // Fully explained: nothing left over.
    expect(adj.lineage!.unexplainedInr).toBe(0)
  })

  // The real-world case that prompted this: a task deleted PERMANENTLY takes
  // its score with it, so nothing is left to name. The gap must be visible.
  it('reports the shortfall as unexplained when no removed task accounts for it', () => {
    const [adj] = computeDeltas(
      m({ e1: 2602 }), m({ e1: 2310.8 }), 7, 2026,
      new Map([['e1', [task({ taskId: 'live', earningsInr: 2310.8 })]]]),
      new Map(),
    )
    expect(adj.lineage!.removedTasks).toEqual([])
    expect(adj.lineage!.unexplainedInr).toBe(-291.2)
  })

  it('accounts for only part of the gap when one of two causes survives', () => {
    const [adj] = computeDeltas(
      m({ e1: 1000 }), m({ e1: 700 }), 7, 2026,
      new Map(),
      new Map([['e1', [task({ earningsInr: 100 })]]]),
    )
    expect(adj.amountInr).toBe(-300)
    expect(adj.lineage!.unexplainedInr).toBe(-200)
  })

  it('carries the live composition so the current figure is auditable', () => {
    const [adj] = computeDeltas(
      m({ e1: 500 }), m({ e1: 850 }), 7, 2026,
      new Map([['e1', [
        task({ taskId: 'a', taskNumber: 1, earningsInr: 600 }),
        task({ taskId: 'b', taskNumber: 2, earningsInr: 250 }),
      ]]]),
      new Map(),
    )
    expect(adj.amountInr).toBe(350)
    expect(adj.lineage!.tasks.map(t => t.taskNumber)).toEqual([1, 2])
    // A late-entered task raises the figure, and no removal explains a RISE.
    expect(adj.lineage!.unexplainedInr).toBe(350)
  })

  // Every existing caller passes no lineage maps; those rows must stay clean
  // rather than gaining an empty, misleading "why".
  it('omits lineage entirely when the caller supplies none', () => {
    const [adj] = computeDeltas(m({ e1: 5000 }), m({ e1: 4200 }), 7, 2026)
    expect(adj.lineage).toBeUndefined()
  })
})
