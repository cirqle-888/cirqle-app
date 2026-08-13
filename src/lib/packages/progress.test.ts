import { describe, it, expect } from 'vitest'
import {
  resolveCoverage, tasksInPeriod, isPackageInForce, isPackageInForceForMonth, taskMonth,
} from './progress'
import type { PackageItemRow, PackageTaskLike } from './types'

const POSTER = 'svc-poster'
const LOGO = 'svc-logo'
const OTHER = 'svc-other'

function item(over: Partial<PackageItemRow> = {}): PackageItemRow {
  return {
    id: 'i1', package_id: 'p1', service_id: POSTER, included_quantity: 15,
    display_order: 0, created_at: '', updated_at: '', ...over,
  }
}

/** n tasks on the same service, one per day from 2026-08-01. */
function tasks(n: number, serviceId = POSTER, month = '2026-08'): PackageTaskLike[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    service_id: serviceId,
    task_date: `${month}-${String(i + 1).padStart(2, '0')}`,
    task_number: 100 + i,
  }))
}

describe('taskMonth', () => {
  it('extracts YYYY-MM', () => {
    expect(taskMonth('2026-08-14')).toBe('2026-08')
  })
})

describe('tasksInPeriod', () => {
  const mixed = [...tasks(2, POSTER, '2026-07'), ...tasks(3, POSTER, '2026-08')]

  it('monthly counts only the given month — the allowance resets', () => {
    expect(tasksInPeriod(mixed, 'monthly', '2026-08')).toHaveLength(3)
    expect(tasksInPeriod(mixed, 'monthly', '2026-07')).toHaveLength(2)
  })

  it('one_time counts everything — the allowance spans the package', () => {
    expect(tasksInPeriod(mixed, 'one_time', '2026-08')).toHaveLength(5)
  })
})

describe('resolveCoverage — the covered/extra split', () => {
  it('covers everything while under the included quantity', () => {
    const c = resolveCoverage(tasks(3), [item({ included_quantity: 15 })], 'monthly', '2026-08')
    expect(c.coveredTaskIds).toHaveLength(3)
    expect(c.extraTaskIds).toEqual([])
    expect(c.perItem[0]).toMatchObject({ included: 15, delivered: 3, remaining: 12, extra: 0 })
  })

  it('covers exactly the included quantity and no more', () => {
    const c = resolveCoverage(tasks(15), [item({ included_quantity: 15 })], 'monthly', '2026-08')
    expect(c.coveredTaskIds).toHaveLength(15)
    expect(c.extraTaskIds).toEqual([])
    expect(c.perItem[0]).toMatchObject({ delivered: 15, remaining: 0, extra: 0 })
  })

  it('the N+1th task is extra — and it is the LATEST one, not an arbitrary one', () => {
    const c = resolveCoverage(tasks(16), [item({ included_quantity: 15 })], 'monthly', '2026-08')
    expect(c.coveredTaskIds).toHaveLength(15)
    expect(c.extraTaskIds).toEqual(['t16'])
    expect(c.perItem[0]).toMatchObject({ delivered: 16, remaining: 0, extra: 1 })
  })

  it('never reports a negative remainder — overage shows as `extra`', () => {
    const c = resolveCoverage(tasks(20), [item({ included_quantity: 15 })], 'monthly', '2026-08')
    expect(c.perItem[0].remaining).toBe(0)
    expect(c.perItem[0].extra).toBe(5)
    expect(c.totalRemaining).toBe(0)
  })

  it('deleting a covered task promotes an extra into coverage', () => {
    const all = tasks(16)
    const before = resolveCoverage(all, [item({ included_quantity: 15 })], 'monthly', '2026-08')
    expect(before.extraTaskIds).toEqual(['t16'])

    // t1 removed → only 15 remain, so nothing is extra any more. This is the
    // reason coverage is derived rather than stamped: a stamped flag on t16
    // would still say "extra" and the client would be billed for it.
    const after = resolveCoverage(all.filter(t => t.id !== 't1'), [item({ included_quantity: 15 })], 'monthly', '2026-08')
    expect(after.extraTaskIds).toEqual([])
    expect(after.coveredTaskIds).toHaveLength(15)
  })

  it('orders by date then task_number, so same-day tasks never swap places', () => {
    const sameDay: PackageTaskLike[] = [
      { id: 'b', service_id: POSTER, task_date: '2026-08-01', task_number: 200 },
      { id: 'a', service_id: POSTER, task_date: '2026-08-01', task_number: 100 },
    ]
    const c = resolveCoverage(sameDay, [item({ included_quantity: 1 })], 'monthly', '2026-08')
    expect(c.coveredTaskIds).toEqual(['a'])   // lower task_number wins
    expect(c.extraTaskIds).toEqual(['b'])
  })
})

describe('resolveCoverage — multiple included lines', () => {
  const items = [
    item({ id: 'i1', service_id: LOGO, included_quantity: 1, display_order: 0 }),
    item({ id: 'i2', service_id: POSTER, included_quantity: 2, display_order: 1 }),
  ]

  it('matches each task to the line for its own service', () => {
    const c = resolveCoverage(
      [...tasks(2, LOGO), ...tasks(3, POSTER)], items, 'one_time', '2026-08',
    )
    expect(c.perItem).toEqual([
      { serviceId: LOGO, included: 1, delivered: 2, scheduled: 0, remaining: 0, extra: 1 },
      { serviceId: POSTER, included: 2, delivered: 3, scheduled: 0, remaining: 0, extra: 1 },
    ])
    expect(c.extraTaskIds).toHaveLength(2)   // one from each line
  })

  it('reports lines in display_order, not insertion order', () => {
    const reversed = [items[1], items[0]]
    const c = resolveCoverage([], reversed, 'one_time', '2026-08')
    expect(c.perItem.map(i => i.serviceId)).toEqual([LOGO, POSTER])
  })

  it('totals across every line', () => {
    const c = resolveCoverage([...tasks(1, LOGO), ...tasks(1, POSTER)], items, 'one_time', '2026-08')
    expect(c.totalIncluded).toBe(3)
    expect(c.totalDelivered).toBe(2)
    expect(c.totalRemaining).toBe(1)
  })
})

describe('resolveCoverage — edge cases', () => {
  it('a package with no included lines delivers nothing and covers nothing', () => {
    const c = resolveCoverage(tasks(5), [], 'monthly', '2026-08')
    expect(c.perItem).toEqual([])
    expect(c.coveredTaskIds).toEqual([])
    expect(c.extraTaskIds).toEqual([])
    expect(c.totalIncluded).toBe(0)
  })

  it('a task on a service the package does not include is neither covered nor extra', () => {
    // It bills on its own like any ordinary task — the client never agreed to
    // it as part of this bundle. Surfaced so the UI can flag the mismatch.
    const c = resolveCoverage(tasks(2, OTHER), [item({ service_id: POSTER })], 'monthly', '2026-08')
    expect(c.coveredTaskIds).toEqual([])
    expect(c.extraTaskIds).toEqual([])
    expect(c.unmatchedTaskIds).toHaveLength(2)
  })

  it('a task with no service at all is unmatched, not silently covered', () => {
    const c = resolveCoverage(
      [{ id: 'x', service_id: null, task_date: '2026-08-01' }], [item()], 'monthly', '2026-08',
    )
    expect(c.unmatchedTaskIds).toEqual(['x'])
    expect(c.coveredTaskIds).toEqual([])
  })

  it('included_quantity 0 makes every task extra', () => {
    const c = resolveCoverage(tasks(2), [item({ included_quantity: 0 })], 'monthly', '2026-08')
    expect(c.coveredTaskIds).toEqual([])
    expect(c.extraTaskIds).toHaveLength(2)
  })

  it('a monthly allowance resets — August work does not eat September', () => {
    const both = [...tasks(15, POSTER, '2026-08'), ...tasks(2, POSTER, '2026-09')]
    const sep = resolveCoverage(both, [item({ included_quantity: 15 })], 'monthly', '2026-09')
    expect(sep.coveredTaskIds).toHaveLength(2)
    expect(sep.extraTaskIds).toEqual([])
    expect(sep.perItem[0].remaining).toBe(13)
  })

  it('a one_time allowance does NOT reset — it spans months', () => {
    const both = [...tasks(1, LOGO, '2026-08'), ...tasks(1, LOGO, '2026-09')]
    const c = resolveCoverage(both, [item({ service_id: LOGO, included_quantity: 1 })], 'one_time', '2026-09')
    expect(c.coveredTaskIds).toHaveLength(1)
    expect(c.extraTaskIds).toHaveLength(1)   // the September one is the overage
  })
})

describe('isPackageInForce', () => {
  const base = { status: 'active', start_date: '2026-08-01', end_date: null as string | null }

  it('is in force inside an open-ended term', () => {
    expect(isPackageInForce(base, '2026-08-14')).toBe(true)
    expect(isPackageInForce(base, '2030-01-01')).toBe(true)
  })

  it('is not in force before it starts or after it ends', () => {
    expect(isPackageInForce(base, '2026-07-31')).toBe(false)
    expect(isPackageInForce({ ...base, end_date: '2026-08-31' }, '2026-09-01')).toBe(false)
  })

  it('treats paused as NOT in force — that is the point of pausing', () => {
    expect(isPackageInForce({ ...base, status: 'paused' }, '2026-08-14')).toBe(false)
  })

  it('excludes completed, cancelled and soft-deleted packages', () => {
    expect(isPackageInForce({ ...base, status: 'completed' }, '2026-08-14')).toBe(false)
    expect(isPackageInForce({ ...base, status: 'cancelled' }, '2026-08-14')).toBe(false)
    expect(isPackageInForce({ ...base, deleted_at: '2026-08-02' }, '2026-08-14')).toBe(false)
  })
})

describe('isPackageInForceForMonth', () => {
  it('bills the month it starts in, even starting mid-month', () => {
    expect(isPackageInForceForMonth(
      { status: 'active', start_date: '2026-08-20', end_date: null }, '2026-08',
    )).toBe(true)
  })

  it('bills the month it ends in, even ending mid-month', () => {
    expect(isPackageInForceForMonth(
      { status: 'active', start_date: '2026-01-01', end_date: '2026-08-03' }, '2026-08',
    )).toBe(true)
  })

  it('does not bill months outside the term', () => {
    const pkg = { status: 'active', start_date: '2026-08-01', end_date: '2026-08-31' }
    expect(isPackageInForceForMonth(pkg, '2026-07')).toBe(false)
    expect(isPackageInForceForMonth(pkg, '2026-09')).toBe(false)
  })

  it('does not bill a paused month', () => {
    expect(isPackageInForceForMonth(
      { status: 'paused', start_date: '2026-08-01', end_date: null }, '2026-08',
    )).toBe(false)
  })
})
