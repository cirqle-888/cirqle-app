import { describe, it, expect } from 'vitest'
import { pickAdjustmentTarget } from './adjustments'

describe('pickAdjustmentTarget — one payslip carries outstanding corrections', () => {
  it('Undo of September: last paid is August, so September carries them', () => {
    expect(pickAdjustmentTarget([
      { month: 8, year: 2026, status: 'paid' }, { month: 9, year: 2026, status: 'pending' },
    ])).toEqual({ month: 9, year: 2026 })
  })
  it('only the EARLIEST pending payslip after the last paid one — never two', () => {
    expect(pickAdjustmentTarget([
      { month: 8, year: 2026, status: 'paid' }, { month: 10, year: 2026, status: 'pending' }, { month: 9, year: 2026, status: 'pending' },
    ])).toEqual({ month: 9, year: 2026 })
  })
  it('stale pending payslips before a later paid month are never chosen', () => {
    expect(pickAdjustmentTarget([
      { month: 1, year: 2026, status: 'pending' }, { month: 8, year: 2026, status: 'paid' }, { month: 9, year: 2026, status: 'paid' },
    ])).toBeNull()
  })
  it('no payslips yet → wait', () => {
    expect(pickAdjustmentTarget([])).toBeNull()
  })
  it('across a year end', () => {
    expect(pickAdjustmentTarget([
      { month: 12, year: 2025, status: 'paid' }, { month: 1, year: 2026, status: 'pending' }, { month: 11, year: 2025, status: 'pending' },
    ])).toEqual({ month: 1, year: 2026 })
  })
})
