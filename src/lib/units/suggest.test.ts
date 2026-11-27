import { describe, expect, it } from 'vitest'
import { describeAllocation, normaliseDescription, phrasesFor, suggestAllocation, validateSplit, type SuggestContext, type SuggestEntry } from './suggest'
import { computeDepartmentShares, type DeptConfig, type EngineEntry } from './engine'

const SOCIAL = 'u-social', FLYERS = 'u-flyers', MEMOURA = 'u-memoura'
const ctx = (over: Partial<SuggestContext> = {}): SuggestContext => ({
  unitName: new Map([[SOCIAL, 'Social Media & Creative'], [FLYERS, 'Cirqle Flyers'], [MEMOURA, 'Memoura']]),
  unitsOfEmployee: new Map([['e4', [SOCIAL]], ['e5', [SOCIAL]]]),
  cqidOf: new Map([['e1', 'CQID001'], ['e2', 'CQID002'], ['e4', 'CQID004'], ['e5', 'CQID005']]),
  unitsOfClient: new Map([['c-sea', [SOCIAL]], ['c-mixed', [SOCIAL, FLYERS]]]),
  clientName: new Map([['c-sea', 'Sea Star Catering'], ['c-mixed', 'Hiba Hypermarket']]),
  learned: new Map(),
  ...over,
})
const entry = (over: Partial<SuggestEntry>): SuggestEntry => ({
  id: 'x', type: 'outflow', description: null, categoryName: null, employeeId: null, clientId: null, ...over,
})

describe('suggestAllocation', () => {
  it('a unit member\'s salary goes to their unit', () => {
    const s = suggestAllocation(entry({ description: 'Salary — CQID004 — October 2026', categoryName: 'Salary', employeeId: 'e4' }), ctx())
    expect(s?.allocation).toEqual({ kind: 'unit', unitId: SOCIAL })
    expect(s?.reason).toContain('CQID004')
  })
  it('finds the person from a CQID in the description', () => {
    expect(suggestAllocation(entry({ description: 'Salary — CQID005 — October 2026' }), ctx())?.allocation)
      .toEqual({ kind: 'unit', unitId: SOCIAL })
  })
  it('someone on no unit and no departments is paid from General', () => {
    expect(suggestAllocation(entry({ description: 'Salary — CQID002', employeeId: 'e2' }), ctx())?.allocation).toEqual({ kind: 'general' })
  })
  it('someone on no team goes by their assigned departments', () => {
    const c = ctx({ assignedUnitsOfEmployee: new Map([['e2', [FLYERS]], ['e1', [SOCIAL, FLYERS, MEMOURA]]]), generalUnitIds: [SOCIAL, FLYERS, MEMOURA] })
    const flyer = suggestAllocation(entry({ description: 'Salary — CQID002', employeeId: 'e2' }), c)
    expect(flyer?.allocation).toEqual({ kind: 'unit', unitId: FLYERS })
    expect(flyer?.reason).toContain('assigned departments')
    // Working across every unit is General, not a three-way split.
    expect(suggestAllocation(entry({ description: 'Salary — CQID001', employeeId: 'e1' }), c)?.allocation).toEqual({ kind: 'general' })
  })
  it('a client cost goes to the client\'s unit; a mixed client splits equally', () => {
    expect(suggestAllocation(entry({ clientId: 'c-sea', categoryName: 'Printing & Stationery' }), ctx())?.allocation)
      .toEqual({ kind: 'unit', unitId: SOCIAL })
    expect(suggestAllocation(entry({ clientId: 'c-mixed' }), ctx())?.allocation)
      .toEqual({ kind: 'split', parts: [{ unitId: SOCIAL, share: 1 }, { unitId: FLYERS, share: 1 }] })
  })
  it('loans, credit and withdrawals are left out', () => {
    expect(suggestAllocation(entry({ categoryName: 'Credit Given' }), ctx())?.allocation).toEqual({ kind: 'exclude' })
    expect(suggestAllocation(entry({ categoryName: 'Personal Withdrawals' }), ctx())?.allocation).toEqual({ kind: 'exclude' })
  })
  it('learns from how the same entry was allocated before', () => {
    const learned = new Map([[normaliseDescription('Ipad 20/24 EMI'), { allocation: { kind: 'split' as const, parts: [{ unitId: SOCIAL, share: 60 }, { unitId: FLYERS, share: 40 }] }, count: 3 }]])
    const s = suggestAllocation(entry({ description: 'Ipad 21/24 EMI', categoryName: 'Business Purchases' }), ctx({ learned }))
    expect(s?.allocation).toEqual({ kind: 'split', parts: [{ unitId: SOCIAL, share: 60 }, { unitId: FLYERS, share: 40 }] })
    expect(s?.confidence).toBe('high')
  })
  it('shared tools go to General', () => {
    expect(suggestAllocation(entry({ description: 'ChatGPT Plus' }), ctx())?.allocation).toEqual({ kind: 'general' })
    expect(suggestAllocation(entry({ description: 'Domain renewal cirqle.work' }), ctx())?.allocation).toEqual({ kind: 'general' })
  })
  it('a description that names a unit goes to that unit', () => {
    const unitPhrases = new Map([[SOCIAL, phrasesFor(['Social Media & Creative', 'Social Media', 'Video'])], [FLYERS, phrasesFor(['Cirqle Flyers', 'Offer Flyers'])]])
    const s = suggestAllocation(entry({ description: 'Social Media Team Meeting from Manjeri Understory', categoryName: 'Food & Entertainment' }), ctx({ unitPhrases }))
    expect(s?.allocation).toEqual({ kind: 'unit', unitId: SOCIAL })
    expect(suggestAllocation(entry({ description: 'Offer flyer printing sample' }), ctx({ unitPhrases }))?.allocation).toEqual({ kind: 'unit', unitId: FLYERS })
  })
  it('phone and recharge costs are shared', () => {
    expect(suggestAllocation(entry({ description: 'Mobile Service - Sales Phone', categoryName: 'Communication & Utilities' }), ctx())?.allocation).toEqual({ kind: 'general' })
  })
  it('says nothing when there is no signal', () => {
    expect(suggestAllocation(entry({ description: 'Ipad 20/24 EMI', categoryName: 'Business Purchases' }), ctx())).toBeNull()
  })
})

describe('normaliseDescription', () => {
  it('drops months, years and counts but keeps CQIDs', () => {
    expect(normaliseDescription('Salary — CQID004 — October 2026')).toBe('salary cqid004')
    expect(normaliseDescription('Ipad 20/24 EMI')).toBe(normaliseDescription('Ipad 21/24 EMI'))
  })
})

describe('validateSplit', () => {
  it('needs percentages to total 100', () => {
    expect(validateSplit([{ unitId: SOCIAL, value: 60 }, { unitId: FLYERS, value: 30 }], 'percent', 1000)).toMatch(/90%/)
    expect(validateSplit([{ unitId: SOCIAL, value: 60 }, { unitId: FLYERS, value: 40 }], 'percent', 1000)).toBeNull()
  })
  it('needs amounts to total the entry', () => {
    expect(validateSplit([{ unitId: SOCIAL, value: 1500 }, { unitId: FLYERS, value: 1108.85 }], 'amount', -2608.85)).toBeNull()
    expect(validateSplit([{ unitId: SOCIAL, value: 1500 }, { unitId: FLYERS, value: 1000 }], 'amount', 2608.85)).toMatch(/2608.85/)
  })
  it('needs two different units', () => {
    expect(validateSplit([{ unitId: SOCIAL, value: 100 }], 'percent', 10)).toMatch(/two units/)
    expect(validateSplit([{ unitId: SOCIAL, value: 50 }, { unitId: SOCIAL, value: 50 }], 'percent', 10)).toMatch(/twice/)
  })
})

describe('describeAllocation', () => {
  it('reads a split in percentages, whatever it was entered in', () => {
    const names = ctx().unitName
    expect(describeAllocation({ kind: 'split', parts: [{ unitId: SOCIAL, share: 1500 }, { unitId: FLYERS, share: 500 }] }, names))
      .toBe('Social Media & Creative 75% · Cirqle Flyers 25%')
  })
})

describe('a split entry in the unit results', () => {
  const unit = (id: string, name: string): DeptConfig => ({
    id, name, slug: id, kind: 'department', color: null, categoryIds: [], revenueBasis: 'collected', sharesGeneralCosts: true,
    teamSeesResults: false, startsOn: '2026-11-01', endsOn: null, isActive: true, partners: [], members: [],
  })
  const ipad: EngineEntry = {
    id: 'ipad', date: '2026-11-12', type: 'outflow', amountInr: 2608.85, description: 'Ipad 20/24 EMI', categoryId: null,
    categoryName: 'Business Purchases', serviceCategoryId: null, clientId: null, reversalOf: null,
    isTransfer: false, isInvoiceReceipt: false, isPassThrough: false,
  }
  it('each unit carries its share, to the paisa', () => {
    const r = computeDepartmentShares({
      departments: [unit(SOCIAL, 'Social'), unit(FLYERS, 'Flyers'), unit(MEMOURA, 'Memoura')],
      months: ['2026-11'], invoices: [], collections: [], entries: [ipad], tags: new Map(), generalCategoryIds: new Set(),
      splits: new Map([['ipad', [{ unitId: SOCIAL, share: 50 }, { unitId: FLYERS, share: 30 }, { unitId: MEMOURA, share: 20 }]]]),
    })
    const cost = (id: string) => r.ledgers.find(l => l.department.id === id)!.months[0].directCostsInr
    expect([cost(SOCIAL), cost(FLYERS), cost(MEMOURA)]).toEqual([1304.43, 782.65, 521.77])
    expect(cost(SOCIAL) + cost(FLYERS) + cost(MEMOURA)).toBeCloseTo(2608.85, 2)
    expect(r.untagged).toEqual([])
    expect(r.ledgers[0].entries[0].splitPct).toBe(50)
  })
  it('a reversal of a split entry nets each unit back to zero', () => {
    const r = computeDepartmentShares({
      departments: [unit(SOCIAL, 'Social'), unit(FLYERS, 'Flyers')],
      months: ['2026-11'], invoices: [], collections: [], tags: new Map(), generalCategoryIds: new Set(),
      entries: [ipad, { ...ipad, id: 'back', type: 'inflow', reversalOf: 'ipad' }],
      splits: new Map([['ipad', [{ unitId: SOCIAL, share: 1 }, { unitId: FLYERS, share: 1 }]]]),
    })
    for (const l of r.ledgers) expect(l.months[0].directCostsInr).toBe(0)
  })
})
