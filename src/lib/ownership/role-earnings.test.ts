import { describe, it, expect } from 'vitest'
import { roleKeyOf, groupByRole, groupByPerson, totalEarned, type AwardLine } from './role-earnings'

const award = (o: Partial<AwardLine>): AwardLine => ({
  employeeId: 'e1', label: null, programName: 'Manager revenue share',
  basis: 'billing', percent: 2, earnedInr: 1000,
  bookedMonth: 7, bookedYear: 2026, ...o,
})

describe('roleKeyOf', () => {
  it('uses the rule label when there is one', () => {
    expect(roleKeyOf({ label: 'Accounts', programName: 'Ops share' })).toBe('Accounts')
  })

  it('falls back to the program name when the rule is unlabeled', () => {
    expect(roleKeyOf({ label: null, programName: 'Ops share' })).toBe('Ops share')
    expect(roleKeyOf({ label: '   ', programName: 'Ops share' })).toBe('Ops share')
  })

  it('trims a padded label rather than creating a near-duplicate hat', () => {
    expect(roleKeyOf({ label: ' Accounts ', programName: 'Ops share' })).toBe('Accounts')
  })
})

describe('groupByRole', () => {
  it('sums one hat across programs, people and months', () => {
    const out = groupByRole([
      award({ label: 'Accounts', employeeId: 'e1', earnedInr: 1000, bookedMonth: 7 }),
      award({ label: 'Accounts', employeeId: 'e1', earnedInr: 500, bookedMonth: 6, programName: 'Quarterly incentive' }),
      award({ label: 'Accounts', employeeId: 'e2', earnedInr: 250, bookedMonth: 7 }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('Accounts')
    expect(out[0].totalInr).toBe(1750)
    expect(out[0].awardCount).toBe(3)
    expect(out[0].people.map(p => p.employeeId)).toEqual(['e1', 'e2'])
    expect(out[0].people[0].totalInr).toBe(1500)
    expect(out[0].people[0].programNames).toEqual(['Manager revenue share', 'Quarterly incentive'])
    expect(out[0].months.map(m => [m.month, m.totalInr])).toEqual([[7, 1250], [6, 500]])
    expect(out[0].months[0].label).toBe('July 2026')
  })

  it('keeps one person\'s hats apart', () => {
    const out = groupByRole([
      award({ label: 'Accounts', earnedInr: 1000 }),
      award({ label: 'HR', earnedInr: 400 }),
      award({ label: 'CEO Direct', earnedInr: 2500 }),
    ])
    expect(out.map(g => [g.role, g.totalInr])).toEqual([
      ['CEO Direct', 2500], ['Accounts', 1000], ['HR', 400],
    ])
  })

  it('buckets unlabeled awards under the program name and says so', () => {
    const [group] = groupByRole([award({ label: null, programName: 'Festival bonus' })])
    expect(group.role).toBe('Festival bonus')
    expect(group.labelled).toBe(false)
  })

  it('rounds to paise rather than carrying float drift into a total', () => {
    const out = groupByRole([
      award({ label: 'Accounts', earnedInr: 0.1 }),
      award({ label: 'Accounts', earnedInr: 0.2 }),
    ])
    expect(out[0].totalInr).toBe(0.3)
  })

  it('returns nothing for no awards', () => {
    expect(groupByRole([])).toEqual([])
  })
})

describe('groupByPerson', () => {
  it('lists every hat a person wears, biggest first', () => {
    const out = groupByPerson([
      award({ employeeId: 'CQ01', label: 'Accounts', earnedInr: 1000, percent: 2 }),
      award({ employeeId: 'CQ01', label: 'HR', earnedInr: 400, percent: 1 }),
      award({ employeeId: 'CQ02', label: 'Accounts', earnedInr: 250, percent: 2 }),
    ])
    expect(out.map(p => [p.employeeId, p.totalInr])).toEqual([['CQ01', 1400], ['CQ02', 250]])
    expect(out[0].hats.map(h => [h.role, h.totalInr, h.percent])).toEqual([
      ['Accounts', 1000, 2], ['HR', 400, 1],
    ])
  })

  it('shows no rate for a hat paid by two programs at different rates', () => {
    const [person] = groupByPerson([
      award({ label: 'Accounts', percent: 2, basis: 'billing', earnedInr: 1000 }),
      award({ label: 'Accounts', percent: 5, basis: 'profit', earnedInr: 300, programName: 'Profit share' }),
    ])
    expect(person.hats[0].percent).toBeNull()
    expect(person.hats[0].basis).toBe('mixed')
    expect(person.hats[0].programNames).toEqual(['Manager revenue share', 'Profit share'])
    expect(person.hats[0].totalInr).toBe(1300)
  })

  it('keeps a fixed-amount hat, which has no percentage at all', () => {
    const [person] = groupByPerson([award({ label: 'Accounts', percent: null, basis: 'fixed', earnedInr: 5000 })])
    expect(person.hats[0]).toMatchObject({ percent: null, basis: 'fixed', totalInr: 5000 })
  })
})

describe('totalEarned', () => {
  it('sums every award', () => {
    expect(totalEarned([award({ earnedInr: 1000 }), award({ earnedInr: 0.5 })])).toBe(1000.5)
  })

  it('is zero for no awards', () => {
    expect(totalEarned([])).toBe(0)
  })
})

describe('resolveRoleWindow', () => {
  const today = new Date(2026, 9, 7)   // 7 Oct 2026
  it('a picked month shows just that month; the future is refused', async () => {
    const { resolveRoleWindow } = await import('./role-earnings')
    expect(resolveRoleWindow({ month: '2026-09' }, today)).toMatchObject({ key: 'month', months: [{ month: 9, year: 2026 }], label: 'September 2026' })
    expect(resolveRoleWindow({ month: '2026-11' }, today).key).toBe('12m')
  })
  it('ranges', async () => {
    const { resolveRoleWindow } = await import('./role-earnings')
    expect(resolveRoleWindow({ range: 'last' }, today).months).toEqual([{ month: 9, year: 2026 }])
    expect(resolveRoleWindow({ range: '3m' }, today).label).toBe('Last 3 months · Aug–Oct 2026')
    expect(resolveRoleWindow({ range: 'ytd' }, today).months).toHaveLength(10)
    expect(resolveRoleWindow({}, today).months).toHaveLength(12)
    expect(resolveRoleWindow({ months: '6' }, today).months).toHaveLength(6)   // old links
  })
  it('arrows never step into the future', async () => {
    const { stepMonth } = await import('./role-earnings')
    expect(stepMonth({ month: 10, year: 2026 }, -1, today)).toBe('2026-09')
    expect(stepMonth({ month: 10, year: 2026 }, 1, today)).toBeNull()
    expect(stepMonth({ month: 1, year: 2026 }, -1, today)).toBe('2025-12')
  })
})
