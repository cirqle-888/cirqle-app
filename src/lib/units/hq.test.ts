import { describe, expect, it } from 'vitest'
import { payByPerson, unitAmounts, unitTeamView, type PayEntry } from './hq'

const SOCIAL = 'u-social', FLYERS = 'u-flyers', MEMOURA = 'u-memoura'
const general = [SOCIAL, FLYERS, MEMOURA]

describe('unitAmounts', () => {
  it('one unit takes it all', () => {
    const a = unitAmounts({ amountInr: 4965 }, { kind: 'dept', departmentId: SOCIAL, how: 'tagged' }, general)
    expect(a.kind === 'units' && Object.fromEntries(a.byUnit)).toEqual({ [SOCIAL]: 4965 })
  })
  it('a split lands to the paisa', () => {
    const a = unitAmounts({ amountInr: 1577 }, { kind: 'split', parts: [{ unitId: SOCIAL, share: 47.01 }, { unitId: FLYERS, share: 52.99 }], how: 'split' }, general)
    expect(a.kind === 'units' && Object.fromEntries(a.byUnit)).toEqual({ [SOCIAL]: 741.35, [FLYERS]: 835.65 })
  })
  it('General goes equally to the units that carry it', () => {
    const a = unitAmounts({ amountInr: 300 }, { kind: 'general', how: 'tagged' }, general)
    expect(a.kind === 'units' && [...a.byUnit.values()]).toEqual([100, 100, 100])
  })
  it('waiting and left out are told apart', () => {
    expect(unitAmounts({ amountInr: 1 }, { kind: 'none', how: 'untagged' }, general).kind).toBe('waiting')
    expect(unitAmounts({ amountInr: 1 }, { kind: 'none', how: 'excluded' }, general).kind).toBe('excluded')
  })
})

describe('payByPerson', () => {
  const cqidOf = new Map([['e1', 'CQID001'], ['e2', 'CQID002'], ['e4', 'CQID004']])
  const teams = new Map([['e4', [SOCIAL]]])
  const entry = (id: string, amountInr: number, employeeId: string | null, description: string | null = null) =>
    ({ id, amountInr, type: 'outflow' as const, employeeId, description })

  it('adds up each person\'s pay by part and where it went', () => {
    const rows: PayEntry[] = [
      {
        entry: entry('a', 4965, 'e4'), kind: { kind: 'dept', departmentId: SOCIAL, how: 'tagged' },
        pay: { employeeId: 'e4', payMonth: '2026-11', parts: { cqid: 'CQID004', base: 0, extra: 0, ownership: 0, commissionByUnit: new Map([[SOCIAL, 4965]]), commissionUnplaced: 0 } },
      },
      { entry: entry('b', 4352, null, 'Salary — CQID002 — November 2026'), kind: { kind: 'none', how: 'untagged' } },
    ]
    const out = payByPerson(rows, cqidOf, teams, general)
    expect(out.map(p => p.cqid)).toEqual(['CQID002', 'CQID004'])
    const four = out.find(p => p.cqid === 'CQID004')!
    expect(four).toMatchObject({ paid: 4965, contribution: 4965, unitIds: [SOCIAL], payMonths: ['2026-11'] })
    expect(Object.fromEntries(four.byUnit)).toEqual({ [SOCIAL]: 4965 })
    const two = out.find(p => p.cqid === 'CQID002')!
    expect(two).toMatchObject({ paid: 4352, waiting: 4352, unitIds: [] })   // office staff, not allocated yet
  })
})

describe('unitTeamView', () => {
  const cqidOf = new Map([['e1', 'CQID001'], ['e2', 'CQID002'], ['e5', 'CQID005']])
  const parts = (cqid: string, base: number, byUnit: [string, number][]) =>
    ({ cqid, base, extra: 0, ownership: 0, commissionByUnit: new Map(byUnit), commissionUnplaced: 0 })
  const rows: PayEntry[] = [
    {
      entry: { id: 'a', amountInr: 3000, type: 'outflow', employeeId: 'e5', description: null },
      kind: { kind: 'split', parts: [{ unitId: SOCIAL, share: 60 }, { unitId: FLYERS, share: 40 }], how: 'split' },
      pay: { employeeId: 'e5', payMonth: '2026-11', parts: parts('CQID005', 1000, [[SOCIAL, 1200], [FLYERS, 800]]) },
    },
    { entry: { id: 'b', amountInr: 900, type: 'outflow', employeeId: 'e2', description: null }, kind: { kind: 'general', how: 'tagged' } },
  ]
  const people = payByPerson(rows, cqidOf, new Map([['e5', [SOCIAL, FLYERS]]]), general)
  const unit = {
    id: SOCIAL,
    members: [{ employeeId: 'e5', cqid: 'CQID005', role: 'member' as const }, { employeeId: 'e1', cqid: 'CQID001', role: 'lead' as const }],
    partners: [{ employeeId: 'e1', sharePct: 40 }, { employeeId: 'e5', sharePct: 30 }],
  }

  it('shows only this unit\'s contribution and what it carries', () => {
    const v = unitTeamView(people, unit)
    const five = v.team.find(r => r.cqid === 'CQID005')!
    expect(five).toMatchObject({ base: 1000, contributionHere: 1200, chargedHere: 1800, sharePct: 30, paid: true })
    expect(Object.values(five)).not.toContain(800)   // Flyers' contribution stays out
    expect(Object.values(five)).not.toContain(3000)  // and so does the total paid
    expect(JSON.stringify(v)).not.toContain(FLYERS)
  })
  it('folds office staff into one owner figure, and lists unpaid members', () => {
    const v = unitTeamView(people, unit)
    expect(v.ownerTeamInr).toBe(300)                 // CQID002's General pay, Social's third
    expect(v.team.map(r => r.cqid)).toEqual(['CQID001', 'CQID005'])
    expect(v.team.find(r => r.cqid === 'CQID001')).toMatchObject({ paid: false, chargedHere: 0 })
    expect(JSON.stringify(v)).not.toContain('CQID002')
  })
})
