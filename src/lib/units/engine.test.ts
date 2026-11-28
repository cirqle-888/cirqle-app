import { describe, expect, it } from 'vitest'
import {
  NONE, classifyEntry, computeDepartmentShares, invoiceSplit, monthsBetween, partnerShares, validateDepartment,
  type DeptConfig, type EngineEntry, type EngineInput, type EngineInvoice, type EntryTag,
} from './engine'

const SOCIAL = 'cat-social'
const VIDEO = 'cat-video'
const FLYER = 'cat-flyer'
const SOFTWARE = 'cb-software'

const social: DeptConfig = {
  id: 'd-social', name: 'Social Media & Creative', slug: 'social', kind: 'department', color: null, teamSeesResults: false,
  members: [{ employeeId: 'e4', cqid: 'CQID004', role: 'lead' }, { employeeId: 'e5', cqid: 'CQID005', role: 'member' }],
  categoryIds: [SOCIAL, VIDEO], revenueBasis: 'collected', sharesGeneralCosts: true,
  startsOn: '2026-11-01', endsOn: null, isActive: true,
  partners: [
    { employeeId: 'owner', cqid: 'CQID001', sharePct: 40 },
    { employeeId: 'e4', cqid: 'CQID004', sharePct: 30 },
    { employeeId: 'e5', cqid: 'CQID005', sharePct: 30 },
  ],
}
const flyers: DeptConfig = {
  id: 'd-flyer', name: 'Cirqle Flyers', slug: 'flyers', kind: 'department', color: null, teamSeesResults: false,
  categoryIds: [FLYER], revenueBasis: 'collected', sharesGeneralCosts: true,
  startsOn: '2026-11-01', endsOn: null, isActive: true,
  // No profit-and-loss agreement: the result stays with Cirqle.
  partners: [], members: [{ employeeId: 'e9', cqid: 'CQID009', role: 'member' }],
}

const inv = (over: Partial<EngineInvoice> & { id: string }): EngineInvoice => ({
  number: over.id, clientId: 'c1', clientName: 'Client', issueDate: '2026-11-05', status: 'paid',
  ownInr: 10000, totalInr: 10000, lines: [{ categoryId: SOCIAL, amount: 10000 }], ...over,
})
const entry = (over: Partial<EngineEntry> & { id: string }): EngineEntry => ({
  date: '2026-11-10', type: 'outflow', amountInr: 1000, description: null, categoryId: null, categoryName: null,
  serviceCategoryId: null, clientId: null, reversalOf: null, isTransfer: false, isInvoiceReceipt: false,
  isPassThrough: false, ...over,
})
const base = (over: Partial<EngineInput> = {}): EngineInput => ({
  departments: [social, flyers], months: ['2026-11'], invoices: [], collections: [], entries: [],
  tags: new Map(), generalCategoryIds: new Set([SOFTWARE]), ...over,
})
const ledger = (r: ReturnType<typeof computeDepartmentShares>, id: string) => r.ledgers.find(l => l.department.id === id)!

describe('partnerShares', () => {
  it('splits a profit 40/30/30 to the paisa', () => {
    const s = partnerShares(10000.01, social.partners)
    expect(s.map(p => p.amountInr)).toEqual([4000.01, 3000, 3000])
    expect(s.reduce((t, p) => t + p.amountInr, 0)).toBeCloseTo(10000.01, 2)
  })
  it('shares a loss the same way', () => {
    expect(partnerShares(-5000, social.partners).map(p => p.amountInr)).toEqual([-2000, -1500, -1500])
  })
})

describe('invoiceSplit', () => {
  const map = new Map([[SOCIAL, social.id], [VIDEO, social.id], [FLYER, flyers.id]])
  it('weights mixed lines by amount', () => {
    const s = invoiceSplit(inv({ id: 'i', lines: [{ categoryId: SOCIAL, amount: 3000 }, { categoryId: FLYER, amount: 1000 }] }), map)
    expect(s.get(social.id)).toBeCloseTo(0.75)
    expect(s.get(flyers.id)).toBeCloseTo(0.25)
  })
  it('puts a line with no department in NONE', () => {
    const s = invoiceSplit(inv({ id: 'i', lines: [{ categoryId: null, amount: 1000 }] }), map)
    expect(s.get(NONE)).toBe(1)
  })
  it('an assignment takes the whole invoice', () => {
    const s = invoiceSplit(inv({ id: 'i', lines: [{ categoryId: FLYER, amount: 1000 }], override: { departmentId: social.id } }), map)
    expect([...s]).toEqual([[social.id, 1]])
  })
})

describe('classifyEntry', () => {
  const map = new Map([[SOCIAL, social.id]])
  const tags = new Map<string, EntryTag>()
  const gen = new Set([SOFTWARE])
  it('a tag wins over everything', () => {
    const t = new Map<string, EntryTag>([['x', { departmentId: null, isGeneral: true, isExcluded: false }]])
    expect(classifyEntry(entry({ id: 'x', serviceCategoryId: SOCIAL }), t, map, gen).kind).toBe('general')
  })
  it('a service of the department puts it there', () => {
    expect(classifyEntry(entry({ id: 'x', serviceCategoryId: SOCIAL }), tags, map, gen)).toEqual({ kind: 'dept', departmentId: social.id, how: 'service' })
  })
  it('a General category makes a company payment General', () => {
    expect(classifyEntry(entry({ id: 'x', categoryId: SOFTWARE }), tags, map, gen).kind).toBe('general')
  })
  it('a client cost in a General category is not General', () => {
    expect(classifyEntry(entry({ id: 'x', categoryId: SOFTWARE, clientId: 'c1' }), tags, map, gen).how).toBe('untagged')
  })
  it('transfers, invoice receipts and pass-through never count by themselves', () => {
    expect(classifyEntry(entry({ id: 'a', isTransfer: true }), tags, map, gen).how).toBe('transfer')
    expect(classifyEntry(entry({ id: 'b', type: 'inflow', isInvoiceReceipt: true }), tags, map, gen).how).toBe('invoice_receipt')
    expect(classifyEntry(entry({ id: 'c', isPassThrough: true, serviceCategoryId: SOCIAL }), tags, map, gen).how).toBe('pass_through')
  })
})

describe('computeDepartmentShares', () => {
  it('collected own revenue minus costs, shared 40/30/30', () => {
    const r = computeDepartmentShares(base({
      invoices: [inv({ id: 'i1' })],
      collections: [{ invoiceId: 'i1', entryId: 'p1', on: '2026-11-08', ownInr: 10000 }],
      entries: [entry({ id: 'cost', amountInr: 2000, serviceCategoryId: VIDEO })],
    }))
    const m = ledger(r, social.id).months[0]
    expect(m.incomeInr).toBe(10000)
    expect(m.directCostsInr).toBe(2000)
    expect(m.resultInr).toBe(8000)
    expect(m.partners.map(p => p.amountInr)).toEqual([3200, 2400, 2400])
  })

  it('splits General costs equally between the departments that share them', () => {
    const r = computeDepartmentShares(base({
      entries: [entry({ id: 'gpt', amountInr: 2000.01, categoryId: SOFTWARE })],
    }))
    const a = ledger(r, social.id).months[0].generalCostsInr
    const b = ledger(r, flyers.id).months[0].generalCostsInr
    expect(a + b).toBeCloseTo(2000.01, 2)
    expect(Math.abs(a - b)).toBeLessThanOrEqual(0.01)
    expect(r.general[0].splitBetween).toEqual([social.id, flyers.id])
    expect(ledger(r, social.id).months[0].resultInr).toBeLessThan(0)
  })

  it('a department that does not share general costs carries none', () => {
    const r = computeDepartmentShares(base({
      departments: [social, { ...flyers, sharesGeneralCosts: false }],
      entries: [entry({ id: 'gpt', amountInr: 1500, categoryId: SOFTWARE })],
    }))
    expect(ledger(r, social.id).months[0].generalCostsInr).toBe(1500)
    expect(ledger(r, flyers.id).months[0].generalCostsInr).toBe(0)
  })

  it('a flyer client invoice counts in Social Media only when assigned', () => {
    const flyerInv = inv({ id: 'f1', clientId: 'flyer-client', lines: [{ categoryId: FLYER, amount: 50000 }], ownInr: 50000 })
    const collections = [{ invoiceId: 'f1', entryId: 'p', on: '2026-11-09', ownInr: 50000 }]
    const before = computeDepartmentShares(base({ invoices: [flyerInv], collections }))
    expect(ledger(before, social.id).months[0].incomeInr).toBe(0)
    expect(ledger(before, flyers.id).months[0].incomeInr).toBe(50000)

    const after = computeDepartmentShares(base({ invoices: [{ ...flyerInv, override: { departmentId: social.id } }], collections }))
    expect(ledger(after, social.id).months[0].incomeInr).toBe(50000)
    expect(ledger(after, flyers.id).months[0].incomeInr).toBe(0)
    expect(ledger(after, social.id).invoices[0].how).toBe('assigned')
  })

  it('an invoice left out of every department is listed as unassigned', () => {
    const r = computeDepartmentShares(base({
      invoices: [inv({ id: 'x', override: { departmentId: null } })],
      collections: [{ invoiceId: 'x', entryId: 'p', on: '2026-11-09', ownInr: 10000 }],
    }))
    expect(ledger(r, social.id).months[0].incomeInr).toBe(0)
    expect(r.unassignedIncome[0]).toMatchObject({ collectedInr: 10000, invoicedInr: 10000 })
  })

  it('invoiced basis counts the invoice in the month it was issued', () => {
    const r = computeDepartmentShares(base({
      departments: [{ ...social, revenueBasis: 'invoiced' }, flyers],
      months: ['2026-11', '2026-12'],
      invoices: [inv({ id: 'i', issueDate: '2026-11-20', ownInr: 6000 })],
      collections: [{ invoiceId: 'i', entryId: 'p', on: '2026-12-03', ownInr: 6000 }],
    }))
    const l = ledger(r, social.id)
    expect(l.months.map(m => m.incomeInr)).toEqual([6000, 0])
  })

  it('nothing before the agreement starts', () => {
    const r = computeDepartmentShares(base({
      months: ['2026-10', '2026-11'],
      invoices: [inv({ id: 'i', issueDate: '2026-10-02' })],
      collections: [{ invoiceId: 'i', entryId: 'p', on: '2026-10-05', ownInr: 10000 }],
    }))
    expect(ledger(r, social.id).months.map(m => m.month)).toEqual(['2026-11'])
    expect(ledger(r, social.id).total.incomeInr).toBe(0)
  })

  it('a reversal follows its original and nets to nothing', () => {
    const tags = new Map<string, EntryTag>([['buy', { departmentId: social.id, isGeneral: false, isExcluded: false }]])
    const r = computeDepartmentShares(base({
      tags,
      entries: [
        entry({ id: 'buy', amountInr: 3000 }),
        entry({ id: 'ret', type: 'inflow', amountInr: 3000, reversalOf: 'buy' }),
      ],
    }))
    const m = ledger(r, social.id).months[0]
    expect(m.directCostsInr).toBe(0)
    expect(m.otherIncomeInr).toBe(0)
    expect(m.resultInr).toBe(0)
  })

  it('tagged receipts are other income; untagged company payments are listed', () => {
    const tags = new Map<string, EntryTag>([['sale', { departmentId: social.id, isGeneral: false, isExcluded: false }]])
    const r = computeDepartmentShares(base({
      tags,
      entries: [entry({ id: 'sale', type: 'inflow', amountInr: 1200 }), entry({ id: 'tea', amountInr: 80 })],
    }))
    expect(ledger(r, social.id).months[0].otherIncomeInr).toBe(1200)
    expect(r.untagged.map(e => e.id)).toEqual(['tea'])
  })

  it('totals add the months and each partner', () => {
    const r = computeDepartmentShares(base({
      months: ['2026-11', '2026-12'],
      invoices: [inv({ id: 'a' }), inv({ id: 'b', issueDate: '2026-12-02' })],
      collections: [
        { invoiceId: 'a', entryId: 'p1', on: '2026-11-08', ownInr: 10000 },
        { invoiceId: 'b', entryId: 'p2', on: '2026-12-08', ownInr: 5000 },
      ],
    }))
    const t = ledger(r, social.id).total
    expect(t.resultInr).toBe(15000)
    expect(t.partners.map(p => p.amountInr)).toEqual([6000, 4500, 4500])
  })
})

describe('a unit with no agreement', () => {
  it('still carries its part of General and has a result, but no partner shares', () => {
    const r = computeDepartmentShares(base({
      invoices: [inv({ id: 'f', lines: [{ categoryId: FLYER, amount: 4000 }], ownInr: 4000 })],
      collections: [{ invoiceId: 'f', entryId: 'p', on: '2026-11-03', ownInr: 4000 }],
      entries: [entry({ id: 'gpt', amountInr: 2000, categoryId: SOFTWARE })],
    }))
    const m = ledger(r, flyers.id).months[0]
    expect(m.generalCostsInr).toBe(1000)
    expect(m.resultInr).toBe(3000)
    expect(m.partners).toEqual([])
  })
})

describe('validateDepartment', () => {
  it('accepts a unit with no agreement', () => {
    expect(validateDepartment(flyers, [social]).ok).toBe(true)
  })
  it('needs shares that total exactly 100', () => {
    const v = validateDepartment({ ...social, partners: [{ employeeId: 'a', cqid: 'A', sharePct: 40 }, { employeeId: 'b', cqid: 'B', sharePct: 30 }] }, [])
    expect(v.ok).toBe(false)
    expect(v.errors.join(' ')).toMatch(/70 %/)
  })
  it('refuses a category another active department already has', () => {
    const v = validateDepartment({ ...flyers, id: 'new', categoryIds: [SOCIAL] }, [social])
    expect(v.ok).toBe(false)
  })
  it('accepts the Social Media agreement', () => {
    expect(validateDepartment(social, [flyers]).ok).toBe(true)
  })
})

describe('monthsBetween', () => {
  it('crosses a year', () => {
    expect(monthsBetween('2026-11-01', '2027-02-15')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02'])
  })
})
