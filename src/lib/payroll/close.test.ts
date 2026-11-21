import { describe, expect, it } from 'vitest'
import { closedPaidDate } from './close'

describe('closedPaidDate', () => {
  it('dates an old payslip on the last day of its month', () => {
    expect(closedPaidDate(11, 2024, '2026-11-21')).toBe('2024-11-30')
    expect(closedPaidDate(4, 2026, '2026-11-21')).toBe('2026-04-30')
  })

  it('knows February and leap years', () => {
    expect(closedPaidDate(2, 2025, '2026-11-21')).toBe('2025-02-28')
    expect(closedPaidDate(2, 2024, '2026-11-21')).toBe('2024-02-29')
  })

  it('handles December without rolling into the next year', () => {
    expect(closedPaidDate(12, 2025, '2026-11-21')).toBe('2025-12-31')
  })

  it('never dates a payment in the future', () => {
    expect(closedPaidDate(11, 2026, '2026-11-21')).toBe('2026-11-21')
  })
})
