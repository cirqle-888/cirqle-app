import { describe, it, expect } from 'vitest'
import { resolveParticipants, earningFor, computeAwards, basisAmount, measuredFor, totalProfitSharePercent } from './compute'
import { monthPeriod } from './periods'
import type { OwnershipProgram, OwnershipRule } from './types'

const rule = (o: Partial<OwnershipRule>): OwnershipRule => ({
  id: 'r1', programId: 'p1', employeeId: null, designationId: null,
  percent: null, fixedAmountInr: null, label: null,
  effectiveFrom: '2026-01-01', effectiveTo: null, isActive: true, ...o,
})

const program = (o: Partial<OwnershipProgram> = {}): OwnershipProgram => ({
  id: 'p1', name: 'Manager revenue share', programType: 'revenue_share',
  basis: 'billing', periodType: 'monthly', scopeKind: 'company', scopeId: null,
  periodStart: null, periodEnd: null,
  effectiveFrom: '2026-01-01', effectiveTo: null, isActive: true, ...o,
})

const byDesignation = new Map([['mgr', ['e1', 'e2', 'e3']], ['hr', ['e4']]])

describe('resolveParticipants', () => {
  it('expands a designation rule to every member', () => {
    const out = resolveParticipants([rule({ designationId: 'mgr', percent: 2 })], byDesignation)
    expect(out.map(p => p.employeeId).sort()).toEqual(['e1', 'e2', 'e3'])
  })

  it('an employee rule REPLACES the designation rule for that person', () => {
    // "Managers get 2%, but e2 gets 3%" must pay e2 3% — not 5%.
    const out = resolveParticipants([
      rule({ id: 'grp', designationId: 'mgr', percent: 2 }),
      rule({ id: 'own', employeeId: 'e2', percent: 3 }),
    ], byDesignation)
    expect(out).toHaveLength(3)
    expect(out.filter(p => p.employeeId === 'e2')).toHaveLength(1)
    expect(out.find(p => p.employeeId === 'e2')!.rule.percent).toBe(3)
    expect(out.find(p => p.employeeId === 'e1')!.rule.percent).toBe(2)
  })

  it('lets an employee rule stand alone when no designation rule exists', () => {
    const out = resolveParticipants([rule({ employeeId: 'solo', percent: 5 })], byDesignation)
    expect(out).toEqual([expect.objectContaining({ employeeId: 'solo' })])
  })

  it('ignores inactive rules', () => {
    expect(resolveParticipants([rule({ designationId: 'mgr', percent: 2, isActive: false })], byDesignation)).toEqual([])
  })

  it('yields nothing for a designation with no members', () => {
    expect(resolveParticipants([rule({ designationId: 'ghost', percent: 2 })], byDesignation)).toEqual([])
  })

  it('stacks separate programs — one person can hold several hats', () => {
    const a = resolveParticipants([rule({ id: 'a', employeeId: 'e1', percent: 2, label: 'Team Lead' })], byDesignation)
    const b = resolveParticipants([rule({ id: 'b', programId: 'p2', employeeId: 'e1', percent: 3, label: 'Ops Manager' })], byDesignation)
    expect([...a, ...b].map(p => p.rule.label)).toEqual(['Team Lead', 'Ops Manager'])
  })
})

describe('earningFor', () => {
  it('takes a percentage of the measured amount', () => {
    expect(earningFor('billing', 100_000, rule({ percent: 2.5 }))).toBe(2500)
  })

  it('pays a fixed amount regardless of basis', () => {
    expect(earningFor('fixed', 0, rule({ fixedAmountInr: 5000 }))).toBe(5000)
    expect(earningFor('profit', -99_999, rule({ fixedAmountInr: 5000 }))).toBe(5000)
  })

  it('CLAMPS AT ZERO in a loss month — never a negative payslip line', () => {
    expect(earningFor('profit', -40_000, rule({ percent: 10 }))).toBe(0)
  })

  it('earns nothing from a percentage on a fixed-basis program', () => {
    expect(earningFor('fixed', 0, rule({ percent: 10 }))).toBe(0)
  })

  it('rounds to paise', () => {
    expect(earningFor('billing', 33_333.33, rule({ percent: 3 }))).toBe(1000)
  })
})

describe('basisAmount', () => {
  const agg = { billingInr: 100, collectedInr: 80, profitInr: 20 }
  it.each([
    ['billing', 100], ['collected', 80], ['profit', 20], ['fixed', 0], ['entries', 0],
  ] as const)('%s → %d', (basis, expected) => {
    expect(basisAmount(basis, agg)).toBe(expected)
  })
})

describe('measuredFor', () => {
  const agg = { billingInr: 100, collectedInr: 80, profitInr: 20, unitsByEmployee: { e1: 142, e2: 7 } }

  it('gives each participant their OWN count on a per-unit basis', () => {
    expect(measuredFor('entries', agg, 'e1')).toBe(142)
    expect(measuredFor('entries', agg, 'e2')).toBe(7)
  })

  it('is 0 for someone who recorded nothing, and when nothing was measured', () => {
    expect(measuredFor('entries', agg, 'nobody')).toBe(0)
    expect(measuredFor('entries', { billingInr: 0, collectedInr: 0, profitInr: 0 }, 'e1')).toBe(0)
  })

  // The regression that protects the four money bases: they are program-wide,
  // so who is asking must make no difference at all.
  it.each(['billing', 'collected', 'profit', 'fixed'] as const)(
    '%s ignores employeeId', basis => {
      expect(measuredFor(basis, agg, 'e1')).toBe(basisAmount(basis, agg))
      expect(measuredFor(basis, agg, 'e2')).toBe(basisAmount(basis, agg))
      expect(measuredFor(basis, agg, 'nobody')).toBe(basisAmount(basis, agg))
    })
})

describe('earningFor on a per-unit basis', () => {
  it('multiplies the rate BY the count — not a one-off flat amount', () => {
    expect(earningFor('entries', 142, rule({ fixedAmountInr: 5 }))).toBe(710)
  })

  it('pays nothing for no entries, and nothing when no rate is set', () => {
    expect(earningFor('entries', 0, rule({ fixedAmountInr: 5 }))).toBe(0)
    expect(earningFor('entries', 142, rule({ fixedAmountInr: null }))).toBe(0)
  })

  // A percent rule on a count basis is a config mistake the UI prevents. It
  // must be ₹0, never NaN — a NaN would reach net_salary.
  it('is 0, never NaN, for a percentage rule', () => {
    expect(earningFor('entries', 142, rule({ percent: 2 }))).toBe(0)
  })

  it('does not disturb a flat fixed award on the fixed basis', () => {
    expect(earningFor('fixed', 0, rule({ fixedAmountInr: 5000 }))).toBe(5000)
  })
})

describe('computeAwards', () => {
  const period = monthPeriod(2026, 7)

  it('produces one snapshotted award per participant', () => {
    const out = computeAwards(
      program(),
      resolveParticipants([rule({ designationId: 'hr', percent: 1.5 })], byDesignation),
      { billingInr: 200_000, collectedInr: 0, profitInr: 0 },
      period,
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      employeeId: 'e4', basis: 'billing', basisAmountInr: 200_000,
      percent: 1.5, earnedInr: 3000,
    })
    expect(out[0].breakdown).toMatchObject({ periodLabel: 'July 2026', ruleSource: 'designation' })
  })

  it('keeps the TRUE negative basis in the snapshot while paying zero', () => {
    // Transparency: a loss month must be auditable, not invisible behind ₹0.
    const out = computeAwards(
      program({ basis: 'profit' }),
      resolveParticipants([rule({ employeeId: 'e1', percent: 10 })], byDesignation),
      { billingInr: 0, collectedInr: 0, profitInr: -50_000 },
      period,
    )
    expect(out[0].earnedInr).toBe(0)
    expect(out[0].basisAmountInr).toBe(-50_000)
    expect(out[0].breakdown).toMatchObject({ clampedAtZero: true })
  })

  it('records which rule paid — employee override vs designation', () => {
    const out = computeAwards(
      program(),
      resolveParticipants([
        rule({ id: 'grp', designationId: 'mgr', percent: 2 }),
        rule({ id: 'own', employeeId: 'e2', percent: 3, label: 'Head of Ops' }),
      ], byDesignation),
      { billingInr: 100_000, collectedInr: 0, profitInr: 0 },
      period,
    )
    const e2 = out.find(a => a.employeeId === 'e2')!
    expect(e2.earnedInr).toBe(3000)
    expect(e2.breakdown).toMatchObject({ ruleSource: 'employee', ruleLabel: 'Head of Ops' })
  })
})

describe('totalProfitSharePercent — the over-commitment guard', () => {
  it('sums every active profit rule across programs', () => {
    const programs = [program({ id: 'p1', basis: 'profit' }), program({ id: 'p2', basis: 'profit' })]
    const rules = [
      rule({ id: 'a', programId: 'p1', designationId: 'mgr', percent: 10 }), // ×3 members
      rule({ id: 'b', programId: 'p2', employeeId: 'e9', percent: 25 }),
    ]
    expect(totalProfitSharePercent(programs, rules, byDesignation)).toBe(55)
  })

  it('ignores non-profit programs — only profit can be over-promised', () => {
    const programs = [program({ id: 'p1', basis: 'billing' })]
    const rules = [rule({ id: 'a', programId: 'p1', designationId: 'mgr', percent: 90 })]
    expect(totalProfitSharePercent(programs, rules, byDesignation)).toBe(0)
  })
})

describe('computeAwards on a per-unit basis', () => {
  const period = monthPeriod(2026, 10)

  // The bug this pins: `measured` used to be computed ONCE above the map, so a
  // per-participant basis would have paid everyone the first person's count.
  it('gives each participant their own count and their own earning', () => {
    const out = computeAwards(
      program({ basis: 'entries', name: 'Accounts Entries', programType: 'entry_rate' }),
      resolveParticipants([
        rule({ id: 'a', employeeId: 'e1', fixedAmountInr: 5, label: 'Accounts Data Entry' }),
        rule({ id: 'b', employeeId: 'e2', fixedAmountInr: 8, label: 'Accounts Data Entry' }),
      ], byDesignation),
      { billingInr: 0, collectedInr: 0, profitInr: 0, unitsByEmployee: { e1: 20, e2: 3 } },
      period,
    )

    const e1 = out.find(a => a.employeeId === 'e1')!
    const e2 = out.find(a => a.employeeId === 'e2')!
    expect(e1.basisAmountInr).toBe(20)
    expect(e2.basisAmountInr).toBe(3)
    expect(e1.earnedInr).toBe(100)   // 20 × ₹5
    expect(e2.earnedInr).toBe(24)    //  3 × ₹8
  })

  it('snapshots the rate and the unit so the award explains itself', () => {
    const [award] = computeAwards(
      program({ basis: 'entries' }),
      resolveParticipants([rule({ employeeId: 'e1', fixedAmountInr: 5 })], byDesignation),
      { billingInr: 0, collectedInr: 0, profitInr: 0, unitsByEmployee: { e1: 20 } },
      period,
    )
    expect(award.fixedAmountInr).toBe(5)
    expect(award.breakdown.units).toBe(20)
    expect(award.breakdown.ratePerUnitInr).toBe(5)
    expect(award.breakdown.unitPlural).toBe('entries')
    expect(award.breakdown.countedOn).toBe('created_at')
  })

  it('pays a participant who recorded nothing exactly ₹0', () => {
    const [award] = computeAwards(
      program({ basis: 'entries' }),
      resolveParticipants([rule({ employeeId: 'e9', fixedAmountInr: 5 })], byDesignation),
      { billingInr: 0, collectedInr: 0, profitInr: 0, unitsByEmployee: {} },
      period,
    )
    expect(award.basisAmountInr).toBe(0)
    expect(award.earnedInr).toBe(0)
  })

  // A money basis must keep sharing ONE program-wide amount across everyone.
  it('leaves a money basis program-wide', () => {
    const out = computeAwards(
      program({ basis: 'billing' }),
      resolveParticipants([rule({ designationId: 'mgr', percent: 2 })], byDesignation),
      { billingInr: 100_000, collectedInr: 0, profitInr: 0, unitsByEmployee: { e1: 99 } },
      period,
    )
    expect(out).toHaveLength(3)
    expect(new Set(out.map(a => a.basisAmountInr))).toEqual(new Set([100_000]))
    expect(new Set(out.map(a => a.earnedInr))).toEqual(new Set([2000]))
  })
})
