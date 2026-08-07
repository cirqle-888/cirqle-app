import { describe, it, expect } from 'vitest'
import { allocateOverhead, computeRecoveryMeter, type RecoveryTask } from './overhead'

describe('allocateOverhead', () => {
  it('splits in proportion to billing', () => {
    const out = allocateOverhead(10_000, [
      { id: 'a', billingInr: 60_000 },
      { id: 'b', billingInr: 40_000 },
    ])
    expect(out.get('a')).toBe(6000)
    expect(out.get('b')).toBe(4000)
  })

  it('sums EXACTLY to the total even when the split does not divide evenly', () => {
    // A profitability report whose overhead column does not tie back to the
    // P&L invites exactly the mistrust this layer exists to prevent.
    const out = allocateOverhead(100, [
      { id: 'a', billingInr: 1 }, { id: 'b', billingInr: 1 }, { id: 'c', billingInr: 1 },
    ])
    const sum = [...out.values()].reduce((s, v) => s + v, 0)
    expect(Math.round(sum * 100) / 100).toBe(100)
  })

  it('allocates nothing when nobody billed — never divides by zero', () => {
    const out = allocateOverhead(5000, [{ id: 'a', billingInr: 0 }, { id: 'b', billingInr: 0 }])
    expect([...out.values()]).toEqual([0, 0])
  })

  it('ignores negative billing rather than handing out negative overhead', () => {
    const out = allocateOverhead(1000, [{ id: 'a', billingInr: 1000 }, { id: 'b', billingInr: -500 }])
    expect(out.get('a')).toBe(1000)
    expect(out.get('b')).toBe(0)
  })

  it('handles an empty entity list', () => {
    expect(allocateOverhead(1000, []).size).toBe(0)
  })
})

describe('computeRecoveryMeter', () => {
  const task = (id: string, date: string, billingInr: number): RecoveryTask => ({ id, date, billingInr })

  it('levies the configured rate per task, in date order', () => {
    const m = computeRecoveryMeter(
      [task('t1', '2026-07-03', 10_000), task('t2', '2026-07-10', 20_000)],
      50_000, 20,
    )
    expect(m.attributions).toEqual([
      { taskId: 't1', date: '2026-07-03', leviedInr: 2000 },
      { taskId: 't2', date: '2026-07-10', leviedInr: 4000 },
    ])
    expect(m.recoveredInr).toBe(6000)
    expect(m.remainingInr).toBe(44_000)
    expect(m.breakEvenDate).toBeNull()
  })

  it('NEVER recovers more than the actual expenses — the cap is the point', () => {
    // Uncapped, a rate would quietly turn a fixed cost into a variable tax on
    // every task for the rest of the month.
    const m = computeRecoveryMeter(
      [task('t1', '2026-07-01', 100_000), task('t2', '2026-07-02', 100_000)],
      5_000, 20,
    )
    expect(m.recoveredInr).toBe(5000)
    expect(m.remainingInr).toBe(0)
    expect(m.attributions).toHaveLength(1)          // the second task levies nothing
    expect(m.attributions[0].leviedInr).toBe(5000)  // and the first is clipped to the cap
  })

  it('reports the break-even date — the day the month covered its costs', () => {
    const m = computeRecoveryMeter(
      [task('t1', '2026-07-05', 10_000), task('t2', '2026-07-14', 10_000), task('t3', '2026-07-20', 10_000)],
      4_000, 20,
    )
    expect(m.breakEvenDate).toBe('2026-07-14')
    expect(m.recoveredInr).toBe(4000)
  })

  it('processes tasks in date order regardless of input order', () => {
    const m = computeRecoveryMeter(
      [task('late', '2026-07-28', 10_000), task('early', '2026-07-02', 10_000)],
      3_000, 20,
    )
    expect(m.attributions[0].taskId).toBe('early')
  })

  it('recovers nothing when no expenses were posted', () => {
    const m = computeRecoveryMeter([task('t1', '2026-07-01', 50_000)], 0, 20)
    expect(m.recoveredInr).toBe(0)
    expect(m.attributions).toEqual([])
  })

  it('recovers nothing at a zero rate', () => {
    const m = computeRecoveryMeter([task('t1', '2026-07-01', 50_000)], 10_000, 0)
    expect(m.recoveredInr).toBe(0)
    expect(m.remainingInr).toBe(10_000)
  })

  it('ignores unbilled work', () => {
    const m = computeRecoveryMeter(
      [task('free', '2026-07-01', 0), task('paid', '2026-07-02', 10_000)],
      10_000, 20,
    )
    expect(m.attributions.map(a => a.taskId)).toEqual(['paid'])
  })
})
