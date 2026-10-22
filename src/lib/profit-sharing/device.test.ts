import { describe, it, expect } from 'vitest'
import {
  PROVISIONAL_DEVICE_POLICY, effectiveWindow, monthsBetween, usageEvidence, validateDevicePolicy, valueTransfer, valueUsage,
  type DeviceFacts,
} from './device'

const policy = PROVISIONAL_DEVICE_POLICY
const facts = (over: Partial<DeviceFacts>): DeviceFacts => ({
  category: 'laptop', condition: 'good', purchaseDate: '2025-01-01', priceInr: 60000, priceIsEstimated: false,
  usageStart: '2025-01-15', usageEnd: null, joinedDate: '2024-06-01', exitDate: null, ...over,
})
const window = { windowStart: '2026-04-01', windowEnd: '2026-09-30' }

describe('design §8.4 worked examples (illustrative parameters)', () => {
  it('A — employee-owned laptop: ₹2,685.25', () => {
    const v = valueUsage({ facts: facts({}), policy, ...window, estimatedShare: (104 / 183) * 0.7 })
    expect(v.modelValueInr).toBe(37125)
    expect(v.remainingLifeMonths).toBe(33)
    expect(v.monthlyWearInr).toBe(1125)
    expect(v.monthsUsed).toBe(6)
    expect(v.basis).toBe('estimated')
    expect(v.proposedInr).toBe(2685.25)
  })

  it('B — employee-owned phone: ₹717.21', () => {
    const v = valueUsage({
      facts: facts({ category: 'phone', condition: 'fair', purchaseDate: '2024-06-01', priceInr: 25000, usageStart: null }),
      policy, ...window, estimatedShare: (140 / 183) * 0.3,
    })
    expect(v.modelValueInr).toBe(7291.67)
    expect(v.remainingLifeMonths).toBe(14)
    expect(v.proposedInr).toBe(717.21)
  })

  it('C — old phone with resale evidence and a verified share: ₹750, flagged above tolerance', () => {
    const v = valueUsage({
      facts: facts({ category: 'phone', purchaseDate: '2022-01-01', priceInr: 30000, usageStart: null }),
      policy, ...window, marketValueInr: 6000, estimatedShare: 0.1, verifiedShare: 0.25,
    })
    expect(v.modelValueInr).toBe(2700)
    expect(v.remainingLifeMonths).toBe(12)
    expect(v.monthlyWearInr).toBe(500)
    expect(v.basis).toBe('verified')
    expect(v.proposedInr).toBe(750)
    expect(v.marketAboveTolerance).toBe(true)
  })

  it('D — transfer of laptop A on 1 Oct: ₹30,375 proposed', () => {
    expect(valueTransfer({ facts: facts({}), policy, asOf: '2026-10-01' }).proposedInr).toBe(30375)
  })
})

describe('guards against over-valuation', () => {
  it('never counts usage before joining or before purchase', () => {
    expect(effectiveWindow(facts({ joinedDate: '2026-06-01' }), '2026-04-01', '2026-09-30')).toEqual({ start: '2026-06-01', end: '2026-09-30' })
    expect(effectiveWindow(facts({ purchaseDate: '2026-12-01' }), '2026-04-01', '2026-09-30')).toBeNull()
  })

  it('stops at exit or the end of declared usage', () => {
    expect(effectiveWindow(facts({ usageEnd: '2026-05-31' }), '2026-04-01', '2026-09-30')).toEqual({ start: '2026-04-01', end: '2026-05-31' })
  })

  it('adds only employee-paid repairs inside the window, at the business share', () => {
    const v = valueUsage({
      facts: facts({}), policy, ...window, estimatedShare: 0.5,
      employeeRepairs: [{ date: '2026-05-10', costInr: 2000 }, { date: '2026-11-01', costInr: 5000 }],
    })
    expect(v.repairsInr).toBe(2000)
    expect(v.proposedInr).toBe(Math.round((1125 * 6 * 0.5 + 2000 * 0.5) * 100) / 100)
  })

  it('measures months by calendar', () => {
    expect(monthsBetween('2026-04-01', '2026-10-01')).toBe(6)
    expect(monthsBetween('2025-01-01', '2026-04-01')).toBe(15)
  })
})

describe('task-based usage evidence (design §8.3)', () => {
  const p = { ...policy, deviceNeedMap: { design: 'laptop' as const, social: 'phone' as const, both: 'both' as const } }

  it('counts distinct days with work that needs this kind of device', () => {
    const e = usageEvidence({
      policy: p, category: 'laptop', windowStart: '2026-04-01', windowEnd: '2026-04-10',
      tasks: [
        { date: '2026-04-01', serviceCategoryId: 'design' },
        { date: '2026-04-01', serviceCategoryId: 'design' },
        { date: '2026-04-02', serviceCategoryId: 'social' },
        { date: '2026-04-03', serviceCategoryId: 'both' },
        { date: '2026-05-01', serviceCategoryId: 'design' },
      ],
    })
    expect(e.availableDays).toBe(10)
    expect(e.deviceWorkDays).toBe(2)
    expect(e.estimatedShare).toBeCloseTo(0.2 * 0.7, 10)
  })

  it('gives a camera no task evidence at all', () => {
    const e = usageEvidence({ policy: p, category: 'camera', windowStart: '2026-04-01', windowEnd: '2026-04-10', tasks: [{ date: '2026-04-01', serviceCategoryId: 'both' }] })
    expect(e.deviceWorkDays).toBe(0)
  })
})

describe('validateDevicePolicy', () => {
  it('accepts the provisional draft', () => {
    expect(validateDevicePolicy(policy)).toEqual([])
  })
  it('refuses impossible values', () => {
    expect(validateDevicePolicy({ ...policy, floorPct: 120, minRemainingMonths: 0 }).length).toBe(2)
  })
})
