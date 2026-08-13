import { describe, it, expect } from 'vitest'
import { planPackageInvoice, extraTaskUnitPrice } from './invoice-lines'
import type { PackageRow, PackageItemRow, PackageTaskLike } from './types'

const POSTER = 'svc-poster'
const LOGO = 'svc-logo'
const OTHER = 'svc-other'

function pkg(over: Partial<PackageRow> = {}): PackageRow {
  return {
    id: 'p1', client_id: 'c1', name: 'Social Media Management',
    billing_type: 'monthly', price: 400, currency: 'AED',
    extra_task_price: 50, start_date: '2026-07-20', end_date: null,
    first_cycle_end: null,
    status: 'active', notes: null, created_by: null,
    created_at: '', updated_at: '', deleted_at: null, ...over,
  }
}

function item(over: Partial<PackageItemRow> = {}): PackageItemRow {
  return {
    id: 'i1', package_id: 'p1', service_id: POSTER, included_quantity: 15,
    display_order: 0, created_at: '', updated_at: '', ...over,
  }
}

function tasks(n: number, serviceId = POSTER, month = '2026-08', fromDay = 1): PackageTaskLike[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${fromDay + i}`,
    service_id: serviceId,
    task_date: `${month}-${String(fromDay + i).padStart(2, '0')}`,
    task_number: 100 + i,
  }))
}

/** The common shape: one package, one included line. */
function plan(over: {
  packages?: PackageRow[]
  items?: PackageItemRow[]
  tasks?: PackageTaskLike[]
  month?: string
  billed?: Set<string>
} = {}) {
  const packages = over.packages ?? [pkg()]
  return planPackageInvoice({
    packages,
    itemsByPackage: new Map(packages.map(p => [p.id, over.items ?? [item({ package_id: p.id })]])),
    tasksByPackage: new Map(packages.map(p => [p.id, over.tasks ?? []])),
    month: over.month ?? '2026-08',
    oneTimeAlreadyBilled: over.billed ?? new Set(),
  })
}

describe('the fee line', () => {
  it('bills the package price, named for the client to read', () => {
    const r = plan()
    expect(r.feeLines).toHaveLength(1)
    expect(r.feeLines[0]).toMatchObject({
      packageId: 'p1', description: 'Social Media Management', amount: 400, currency: 'AED',
    })
  })

  it('bills a monthly package EVERY month it is in force', () => {
    expect(plan({ month: '2026-08' }).feeLines).toHaveLength(1)
    expect(plan({ month: '2026-09' }).feeLines).toHaveLength(1)
    expect(plan({ month: '2026-12' }).feeLines).toHaveLength(1)
  })

  it('does not bill a month outside the term', () => {
    // Package starts 20 Jul — June is before it.
    expect(plan({ month: '2026-06' }).feeLines).toEqual([])
    const ended = [pkg({ end_date: '2026-08-31' })]
    expect(plan({ packages: ended, month: '2026-09' }).feeLines).toEqual([])
  })

  it('bills the starting month even when the package starts mid-month', () => {
    expect(plan({ month: '2026-07' }).feeLines).toHaveLength(1)
  })

  it('does not bill a paused, completed or cancelled package', () => {
    for (const status of ['paused', 'completed', 'cancelled'] as const) {
      expect(plan({ packages: [pkg({ status })] }).feeLines, status).toEqual([])
    }
  })

  it('dates the fee line to the earliest work it paid for', () => {
    const r = plan({ tasks: tasks(3, POSTER, '2026-08') })
    expect(r.feeLines[0].lineDate).toBe('2026-08-01')
  })

  it('falls back to the start date when no work was done that month', () => {
    expect(plan({ tasks: [] }).feeLines[0].lineDate).toBe('2026-07-20')
  })
})

describe('an extended opening cycle (Elara: signed 20 Jul, first cycle to 31 Aug)', () => {
  // The package starts 20 July. Without this option July and August are two
  // cycles and the client is billed AED 400 twice for what was sold as one
  // opening period.
  const first = [pkg({ first_cycle_end: '2026-08-31' })]

  it('bills ONCE, on the month the package started', () => {
    expect(plan({ packages: first, month: '2026-07' }).feeLines).toHaveLength(1)
    expect(plan({ packages: first, month: '2026-08' }).feeLines).toEqual([])
  })

  it('names the line so the client can see why it covers two months', () => {
    expect(plan({ packages: first, month: '2026-07' }).feeLines[0].description)
      .toBe('Social Media Management — first cycle')
  })

  it('resumes normal monthly billing after the opening cycle', () => {
    expect(plan({ packages: first, month: '2026-09' }).feeLines).toHaveLength(1)
    expect(plan({ packages: first, month: '2026-09' }).feeLines[0].description)
      .toBe('Social Media Management')
  })

  it('carries ONE allowance across the whole span, not one per month', () => {
    // 8 from 20 Jul + 7 in August = 15. All covered; none is an extra.
    const both = [...tasks(8, POSTER, '2026-07', 20), ...tasks(7, POSTER, '2026-08')]
    const r = plan({ packages: first, tasks: both, month: '2026-08' })
    expect(r.coveredTaskIds.size).toBe(15)
    expect(r.extras).toEqual([])
  })

  it('treats the 16th task in the span as an extra', () => {
    const both = [...tasks(8, POSTER, '2026-07', 20), ...tasks(8, POSTER, '2026-08')]
    const r = plan({ packages: first, tasks: both, month: '2026-08' })
    expect(r.coveredTaskIds.size).toBe(15)
    expect(r.extras).toHaveLength(1)
    expect(r.extras[0].unitPrice).toBe(50)
  })

  it('does not count work done BEFORE the package was signed', () => {
    // Linked by hand to work predating 20 Jul. It is not part of what was
    // committed, so it bills on its own rather than eating the allowance.
    const r = plan({ packages: first, tasks: tasks(3, POSTER, '2026-07', 1), month: '2026-07' })
    expect(r.coveredTaskIds.size).toBe(0)
  })

  it('still covers August work even though August carries no fee', () => {
    // The risk this guards: no fee line on August could be read as "the package
    // does not apply in August", which would bill every August task on its own.
    const r = plan({ packages: first, tasks: tasks(3, POSTER, '2026-08'), month: '2026-08' })
    expect(r.feeLines).toEqual([])
    expect(r.coveredTaskIds.size).toBe(3)
  })

  it('gives September a fresh 15 once the opening cycle has passed', () => {
    const spanning = [...tasks(15, POSTER, '2026-08'), ...tasks(2, POSTER, '2026-09')]
    const r = plan({ packages: first, tasks: spanning, month: '2026-09' })
    expect(r.coveredTaskIds.size).toBe(2)
    expect(r.extras).toEqual([])
  })

  it('ignores an opening cycle that ends inside the starting month', () => {
    const sameMonth = [pkg({ first_cycle_end: '2026-07-31' })]
    expect(plan({ packages: sameMonth, month: '2026-07' }).feeLines[0].description)
      .toBe('Social Media Management')
    expect(plan({ packages: sameMonth, month: '2026-08' }).feeLines).toHaveLength(1)
  })

  it('leaves one-time packages alone — they have no cycles to extend', () => {
    const once = [pkg({ id: 'p9', billing_type: 'one_time', price: 150, first_cycle_end: '2026-08-31' })]
    expect(plan({ packages: once, month: '2026-09' }).feeLines).toHaveLength(1)
  })
})

describe('one-time packages bill exactly once', () => {
  const oneTime = [pkg({ id: 'p2', billing_type: 'one_time', name: 'Brand Identity Essential', price: 150 })]
  const items = [item({ package_id: 'p2', service_id: LOGO, included_quantity: 2 })]

  it('bills on an invoice where it has not been billed before', () => {
    const r = plan({ packages: oneTime, items, month: '2026-08' })
    expect(r.feeLines).toHaveLength(1)
    expect(r.feeLines[0].amount).toBe(150)
  })

  it('dates the fee to the day the package was agreed, not the first task', () => {
    // The commitment began 20 Jul; a logo task on the 23rd doesn't move that.
    const r = plan({
      packages: oneTime, items,
      tasks: tasks(1, LOGO, '2026-07', 23), month: '2026-08',
    })
    expect(r.feeLines[0].lineDate).toBe('2026-07-20')
  })

  it('does NOT bill again once it already carries a fee line somewhere', () => {
    const r = plan({ packages: oneTime, items, month: '2026-09', billed: new Set(['p2']) })
    expect(r.feeLines).toEqual([])
  })

  it('still covers its tasks in later months even though it no longer bills', () => {
    // The fee was charged in July; September work is still included — it must
    // not suddenly start billing per task just because the fee already went out.
    const r = plan({
      packages: oneTime, items,
      tasks: tasks(2, LOGO, '2026-09'),
      month: '2026-09', billed: new Set(['p2']),
    })
    expect(r.feeLines).toEqual([])
    expect([...r.coveredTaskIds]).toHaveLength(2)
    expect(r.extras).toEqual([])
  })
})

describe('covered vs extra tasks', () => {
  it('covers tasks up to the included quantity — none get their own line', () => {
    const r = plan({ tasks: tasks(15) })
    expect(r.coveredTaskIds.size).toBe(15)
    expect(r.extras).toEqual([])
  })

  it('bills the overflow separately at the agreed extra rate', () => {
    const r = plan({ tasks: tasks(17) })
    expect(r.coveredTaskIds.size).toBe(15)
    expect(r.extras.map(e => e.taskId)).toEqual(['t16', 't17'])
    expect(r.extras[0]).toMatchObject({ unitPrice: 50, currency: 'AED', packageId: 'p1' })
  })

  it('leaves extras at their matrix price when no extra rate is agreed', () => {
    const r = plan({ packages: [pkg({ extra_task_price: null })], tasks: tasks(16) })
    expect(r.extras[0].unitPrice).toBeNull()
  })

  it('only considers the invoice month — last month\'s work is not this month\'s overage', () => {
    const both = [...tasks(15, POSTER, '2026-07'), ...tasks(2, POSTER, '2026-08')]
    const r = plan({ tasks: both, month: '2026-08' })
    expect(r.coveredTaskIds.size).toBe(2)   // August's two, both within the fresh 15
    expect(r.extras).toEqual([])
  })

  it('flags a linked task on a service the package does not include', () => {
    const r = plan({ tasks: tasks(2, OTHER) })
    expect(r.coveredTaskIds.size).toBe(0)
    expect(r.extras).toEqual([])
    expect(r.unmatchedTaskIds.size).toBe(2)  // bills normally, like any other task
  })
})

describe('several packages on one invoice', () => {
  const monthly = pkg({ id: 'pm', name: 'Social Media Management' })
  const oneTime = pkg({ id: 'po', billing_type: 'one_time', name: 'Brand Identity Essential', price: 150 })

  it('carries a fee line for each, and covers each one\'s own tasks', () => {
    const r = planPackageInvoice({
      packages: [monthly, oneTime],
      itemsByPackage: new Map([
        ['pm', [item({ package_id: 'pm', service_id: POSTER, included_quantity: 15 })]],
        ['po', [item({ package_id: 'po', service_id: LOGO, included_quantity: 2 })]],
      ]),
      tasksByPackage: new Map([
        ['pm', tasks(2, POSTER, '2026-08')],
        ['po', tasks(1, LOGO, '2026-08').map(t => ({ ...t, id: 'logo1' }))],
      ]),
      month: '2026-08',
      oneTimeAlreadyBilled: new Set(),
    })
    expect(r.feeLines.map(f => f.description).sort())
      .toEqual(['Brand Identity Essential', 'Social Media Management'])
    expect(r.coveredTaskIds.size).toBe(3)
  })

  it('suppresses only the already-billed one-time fee, keeping the monthly one', () => {
    const r = planPackageInvoice({
      packages: [monthly, oneTime],
      itemsByPackage: new Map([['pm', [item({ package_id: 'pm' })]], ['po', [item({ package_id: 'po', service_id: LOGO })]]]),
      tasksByPackage: new Map(),
      month: '2026-09',
      oneTimeAlreadyBilled: new Set(['po']),
    })
    expect(r.feeLines.map(f => f.description)).toEqual(['Social Media Management'])
  })
})

describe('only finished work consumes the allowance', () => {
  // The money rule. An unfinished task that merely exists must not take a
  // covered slot, or a genuinely delivered task gets pushed past `included`
  // and billed as overage for work the fee already paid for.
  const small = [pkg({ id: 'ps' })]
  const items = [item({ package_id: 'ps', included_quantity: 2 })]

  it('does not let a pending task push a done task into overage', () => {
    const r = plan({
      packages: small, items,
      tasks: [
        { id: 'pending-1', service_id: POSTER, task_date: '2026-08-01', task_number: 1, status: 'pending' },
        { id: 'pending-2', service_id: POSTER, task_date: '2026-08-02', task_number: 2, status: 'pending' },
        { id: 'done-1',    service_id: POSTER, task_date: '2026-08-03', task_number: 3, status: 'done' },
      ],
    })
    // Before this rule the two pending tasks filled both slots and `done-1`
    // billed as an extra.
    expect([...r.coveredTaskIds]).toEqual(['done-1'])
    expect(r.extras).toEqual([])
  })

  it('treats invoiced as delivered — it is a post-done state', () => {
    const r = plan({
      packages: small, items,
      tasks: [{ id: 'inv', service_id: POSTER, task_date: '2026-08-01', task_number: 1, status: 'invoiced' }],
    })
    expect([...r.coveredTaskIds]).toEqual(['inv'])
  })

  it('drops cancelled work entirely — not covered, not extra, not owed', () => {
    const r = plan({
      packages: small, items,
      tasks: [
        { id: 'x', service_id: POSTER, task_date: '2026-08-01', task_number: 1, status: 'cancelled' },
        { id: 'y', service_id: POSTER, task_date: '2026-08-02', task_number: 2, status: 'done' },
      ],
    })
    expect([...r.coveredTaskIds]).toEqual(['y'])
    expect(r.extras).toEqual([])
    expect(r.unmatchedTaskIds.size).toBe(0)
  })

  it('still bills a done task as extra once the allowance is genuinely used', () => {
    const r = plan({
      packages: small, items,
      tasks: [
        { id: 'd1', service_id: POSTER, task_date: '2026-08-01', task_number: 1, status: 'done' },
        { id: 'd2', service_id: POSTER, task_date: '2026-08-02', task_number: 2, status: 'done' },
        { id: 'd3', service_id: POSTER, task_date: '2026-08-03', task_number: 3, status: 'done' },
      ],
    })
    expect(r.coveredTaskIds.size).toBe(2)
    expect(r.extras.map(e => e.taskId)).toEqual(['d3'])
  })

  it('assumes delivered when the caller did not select a status', () => {
    // Protects a partial query from silently zeroing a client's progress.
    const r = plan({ packages: small, items, tasks: tasks(2) })
    expect(r.coveredTaskIds.size).toBe(2)
  })
})

describe('extraTaskUnitPrice', () => {
  const charge = { taskId: 't', packageId: 'p', currency: 'AED', unitPrice: 50 }

  it('uses the agreed extra rate when one is set', () => {
    expect(extraTaskUnitPrice(charge, 20)).toBe(50)
  })

  it('keeps the matrix price when no rate is agreed — null is not zero', () => {
    expect(extraTaskUnitPrice({ ...charge, unitPrice: null }, 20)).toBe(20)
  })

  it('keeps the matrix price for a task that is not an extra at all', () => {
    expect(extraTaskUnitPrice(undefined, 20)).toBe(20)
  })

  it('honours an agreed rate of 0 — a deliberately free extra', () => {
    expect(extraTaskUnitPrice({ ...charge, unitPrice: 0 }, 20)).toBe(0)
  })
})
