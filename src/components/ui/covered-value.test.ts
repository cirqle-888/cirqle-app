import { describe, it, expect } from 'vitest'
import { coveredValueDisplay } from './covered-value'

/**
 * Every covered task in the database is quantity 1 today, so the per-unit
 * branch is unreachable in the browser. These pin the arithmetic instead.
 */
describe('coveredValueDisplay', () => {
  it('shows the full work value for a one-time item (quantity 1)', () => {
    const d = coveredValueDisplay(
      { work_value: 1949.67, work_value_currency: 'INR', work_value_inr: 1949.67 },
      1,
    )
    expect(d.hasValue).toBe(true)
    expect(d.label).toBe('₹1,949.67')
    expect(d.label).not.toContain('/ unit')
  })

  it('divides by quantity and says so when the task covers several units', () => {
    const d = coveredValueDisplay(
      { work_value: 900, work_value_currency: 'INR', work_value_inr: 900 },
      3,
    )
    expect(d.label).toBe('₹300.00 / unit')
    expect(d.tooltip).toContain('₹300.00 / unit pays the team')
  })

  it('quotes the agreement currency and restates INR only when they differ', () => {
    const foreign = coveredValueDisplay(
      { work_value: 20, work_value_currency: 'AED', work_value_inr: 519.91 },
      1,
    )
    expect(foreign.label).toContain('20')
    expect(foreign.tooltip).toContain('(₹519.91)')

    const rupee = coveredValueDisplay(
      { work_value: 519.91, work_value_currency: 'INR', work_value_inr: 519.91 },
      1,
    )
    // "₹519.91 pays the team (₹519.91)" reads like a bug.
    expect(rupee.tooltip).not.toContain('(₹')
  })

  it('falls back to the INR figure when the native value is absent', () => {
    const d = coveredValueDisplay({ work_value_inr: 500 }, 2)
    expect(d.label).toBe('₹250.00 / unit')
  })

  it('flags an agreement item with no work value rather than showing ₹0', () => {
    const d = coveredValueDisplay({ work_value: 0, work_value_currency: 'INR', work_value_inr: 0 })
    expect(d.hasValue).toBe(false)
    expect(d.label).toBe('No work value')
    expect(d.tooltip).toContain('pays contributors nothing')
  })
})
