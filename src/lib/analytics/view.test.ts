import { describe, it, expect } from 'vitest'
import { buildView, sliceView } from './view'
import { aggregateByMonth, type AnalyticsTask } from './historical'

/**
 * The seam between cached history and the live current month is the thing
 * most likely to go wrong, and least likely to be noticed: a double count or
 * a dropped month changes a revenue figure by a plausible amount.
 */

const task = (date: string, value: number, over: Partial<AnalyticsTask> = {}): AnalyticsTask => ({
  task_date: date,
  billing_amount_inr: value,
  quantity: 1,
  is_billable: true,
  status: 'done',
  client: { id: 'c1', name: 'Sea Star' },
  service_id: 's1',
  service: { id: 's1', name: 'Flyer' },
  ...over,
})

describe('joining cached history to the live month', () => {
  it('adds both halves once', () => {
    const history = aggregateByMonth([task('2026-07-10', 100), task('2026-08-10', 200)])
    const live = [task('2026-09-05', 50)]
    const v = buildView(history, live)
    expect(v.months.map(m => m.month)).toEqual(['2026-07', '2026-08', '2026-09'])
    expect(v.taskValue).toBe(350)
    expect(v.taskCount).toBe(3)
  })

  it('never double-counts a month present on both sides — live wins', () => {
    // The overlap case: if the windows ever drift, fresh rows are by
    // definition more correct than a cached aggregate of the same month.
    const history = aggregateByMonth([task('2026-09-01', 999)])
    const live = [task('2026-09-01', 50), task('2026-09-02', 25)]
    const v = buildView(history, live)
    expect(v.months).toHaveLength(1)
    expect(v.taskValue).toBe(75)
  })

  it('works with no history at all', () => {
    const v = buildView([], [task('2026-09-05', 50)])
    expect(v.taskValue).toBe(50)
  })

  it('works with no live rows — an empty current month', () => {
    const v = buildView(aggregateByMonth([task('2026-08-10', 200)]), [])
    expect(v.taskValue).toBe(200)
    expect(v.months).toHaveLength(1)
  })

  it('is empty, not broken, with neither', () => {
    const v = buildView([], [])
    expect(v).toMatchObject({ taskValue: 0, taskCount: 0, months: [], days: [] })
  })
})

describe('narrowing to a date window', () => {
  const view = buildView(
    aggregateByMonth([
      task('2026-07-05', 100), task('2026-07-25', 200),
      task('2026-08-10', 300), task('2026-08-20', 400),
    ]),
    [],
  )

  it('totals a mid-month window exactly, from day rows', () => {
    // The case month totals could never answer.
    const s = sliceView(view, { from: '2026-07-20', to: '2026-08-15' })
    expect(s.taskValue).toBe(500)     // 200 + 300
    expect(s.taskCount).toBe(2)
  })

  it('counts creatives by quantity inside the window', () => {
    const v = buildView(aggregateByMonth([
      task('2026-07-05', 100, { quantity: 4 }),
      task('2026-07-25', 200, { quantity: 3 }),
    ]), [])
    expect(sliceView(v, { from: '2026-07-20', to: '2026-07-31' }).creativeCount).toBe(3)
  })

  it('says when the client split is exact — whole months only', () => {
    const whole = sliceView(view, { from: '2026-07-01', to: '2026-08-31' })
    expect(whole.clientSplitExact).toBe(true)
    expect(whole.byClient[0].count).toBe(4)
  })

  it('admits when the client split cannot be exact, instead of inventing one', () => {
    // A partial month cannot apportion a per-client total honestly. Saying so
    // is the difference between a caveat and a wrong number.
    const partial = sliceView(view, { from: '2026-07-20', to: '2026-08-15' })
    expect(partial.clientSplitExact).toBe(false)
  })

  it('is empty for a window with no work in it', () => {
    const s = sliceView(view, { from: '2026-01-01', to: '2026-01-31' })
    expect(s.taskValue).toBe(0)
    expect(s.taskCount).toBe(0)
    expect(s.days).toEqual([])
  })

  it('includes both boundary days', () => {
    const s = sliceView(view, { from: '2026-07-05', to: '2026-07-05' })
    expect(s.taskCount).toBe(1)
    expect(s.taskValue).toBe(100)
  })
})

describe('the window totals agree with the rows they came from', () => {
  it('matches a direct sum over the tasks in range', () => {
    const tasks: AnalyticsTask[] = []
    for (let d = 1; d <= 28; d++) {
      tasks.push(task(`2026-07-${String(d).padStart(2, '0')}`, d * 10, { quantity: (d % 3) + 1 }))
    }
    const v = buildView(aggregateByMonth(tasks), [])
    const s = sliceView(v, { from: '2026-07-10', to: '2026-07-20' })

    const inRange = tasks.filter(t => t.task_date! >= '2026-07-10' && t.task_date! <= '2026-07-20')
    expect(s.taskValue).toBeCloseTo(inRange.reduce((x, t) => x + (t.billing_amount_inr || 0), 0), 2)
    expect(s.taskCount).toBe(inRange.length)
    expect(s.creativeCount).toBe(inRange.reduce((x, t) => x + Number(t.quantity ?? 1), 0))
  })
})
