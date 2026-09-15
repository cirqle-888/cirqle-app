import { describe, it, expect } from 'vitest'
import { aggregateByMonth, mergeMonths, monthKey, isHistoricalMonth, type AnalyticsTask } from './historical'

/**
 * The promise these hold: an aggregate says exactly what the rows said.
 *
 * A cache that is fast and slightly wrong is worse than no cache, because the
 * wrongness is invisible — nobody re-adds a dashboard by hand. So the tests
 * that matter most are the ones comparing aggregated output against the same
 * arithmetic done directly over the rows.
 */

const task = (over: Partial<AnalyticsTask> = {}): AnalyticsTask => ({
  task_date: '2026-03-15',
  billing_amount_inr: 1000,
  is_billable: true,
  status: 'done',
  client: { id: 'c1', name: 'Sea Star' },
  service_id: 's1',
  service: { id: 's1', name: 'Offer Flyer' },
  ...over,
})

describe('monthKey', () => {
  it('takes the month out of a date', () => {
    expect(monthKey('2026-03-15')).toBe('2026-03')
  })
  it('is null for anything unusable, rather than guessing', () => {
    for (const d of [null, undefined, '', 'nope', '2026']) expect(monthKey(d)).toBeNull()
  })
})

describe('aggregateByMonth', () => {
  it('totals work done per month', () => {
    const out = aggregateByMonth([
      task({ task_date: '2026-03-01', billing_amount_inr: 1000 }),
      task({ task_date: '2026-03-20', billing_amount_inr: 500 }),
      task({ task_date: '2026-04-02', billing_amount_inr: 300 }),
    ])
    expect(out.map(m => m.month)).toEqual(['2026-03', '2026-04'])
    expect(out[0]).toMatchObject({ taskValue: 1500, taskCount: 2 })
    expect(out[1]).toMatchObject({ taskValue: 300, taskCount: 1 })
  })

  it('counts waived work as value done but not as revenue', () => {
    // The live dashboard's asymmetry, kept: a waived job is worth its price
    // internally, and must not lift a client up the ranking.
    const out = aggregateByMonth([
      task({ billing_amount_inr: 1000, is_billable: true }),
      task({ billing_amount_inr: 400, is_billable: false }),
    ])
    expect(out[0].taskValue).toBe(1400)
    expect(out[0].byClient[0].revenue).toBe(1000)
    expect(out[0].byClient[0].count).toBe(2)
  })

  it('splits by client and by service', () => {
    const out = aggregateByMonth([
      task({ client: { id: 'c1', name: 'Sea Star' }, service_id: 's1', service: { id: 's1', name: 'Flyer' } }),
      task({ client: { id: 'c2', name: 'Bismi' }, billing_amount_inr: 2000, service_id: 's2', service: { id: 's2', name: 'Social' } }),
    ])
    expect(out[0].byClient.map(c => c.name)).toEqual(['Bismi', 'Sea Star'])   // by revenue
    expect(out[0].byService.map(s => s.name)).toEqual(['Social', 'Flyer'])
  })

  it('drops rows with an unusable date instead of bucketing them somewhere', () => {
    const out = aggregateByMonth([task(), task({ task_date: null })])
    expect(out).toHaveLength(1)
    expect(out[0].taskCount).toBe(1)
  })

  it('ignores a task with no client or service rather than inventing one', () => {
    const out = aggregateByMonth([task({ client: null, service: null, service_id: null })])
    expect(out[0].taskCount).toBe(1)
    expect(out[0].byClient).toEqual([])
    expect(out[0].byService).toEqual([])
  })

  it('is empty for no rows', () => {
    expect(aggregateByMonth([])).toEqual([])
  })

  it('carries no employee data at all', () => {
    // Point 8: an aggregate cannot leak a name it never held.
    const json = JSON.stringify(aggregateByMonth([task()]))
    expect(json).not.toMatch(/employee/i)
    expect(json).not.toMatch(/cqid/i)
  })
})

describe('aggregated equals row-by-row — the correctness promise', () => {
  it('matches the same sums computed directly over the rows', () => {
    const rows: AnalyticsTask[] = []
    for (let i = 0; i < 120; i++) {
      rows.push(task({
        task_date: `2026-0${(i % 3) + 1}-1${i % 9}`,
        billing_amount_inr: 100 + i,
        is_billable: i % 5 !== 0,
        client: { id: 'c' + (i % 4), name: 'Client ' + (i % 4) },
        service_id: 's' + (i % 3),
        service: { id: 's' + (i % 3), name: 'Service ' + (i % 3) },
      }))
    }

    // What the live dashboard would compute, straight from the rows.
    const liveValue = rows.reduce((s, t) => s + (t.billing_amount_inr || 0), 0)
    const liveRevenueByClient = new Map<string, number>()
    for (const t of rows) {
      const rev = t.is_billable === false ? 0 : (t.billing_amount_inr || 0)
      liveRevenueByClient.set(t.client!.id, (liveRevenueByClient.get(t.client!.id) || 0) + rev)
    }

    const merged = mergeMonths(aggregateByMonth(rows))
    expect(merged.taskValue).toBeCloseTo(liveValue, 2)
    expect(merged.taskCount).toBe(rows.length)
    for (const [clientId, revenue] of liveRevenueByClient) {
      expect(merged.byClient.find(c => c.id === clientId)!.revenue).toBeCloseTo(revenue, 2)
    }
  })
})

describe('mergeMonths', () => {
  it('adds a quarter together without going back to the rows', () => {
    const months = aggregateByMonth([
      task({ task_date: '2026-01-10', billing_amount_inr: 100 }),
      task({ task_date: '2026-02-10', billing_amount_inr: 200 }),
      task({ task_date: '2026-03-10', billing_amount_inr: 300 }),
    ])
    const q = mergeMonths(months)
    expect(q.taskValue).toBe(600)
    expect(q.taskCount).toBe(3)
    expect(q.byClient[0].count).toBe(3)
  })

  it('keeps a renamed client under one id, with its newest spelling', () => {
    const months = aggregateByMonth([
      task({ task_date: '2026-01-10', client: { id: 'c1', name: 'Sea Star' } }),
      task({ task_date: '2026-02-10', client: { id: 'c1', name: 'Sea Star Supermarket' } }),
    ])
    const merged = mergeMonths(months)
    expect(merged.byClient).toHaveLength(1)
    expect(merged.byClient[0].name).toBe('Sea Star Supermarket')
    expect(merged.byClient[0].count).toBe(2)
  })

  it('is zero for nothing', () => {
    expect(mergeMonths([])).toMatchObject({ taskValue: 0, taskCount: 0, byClient: [], byService: [] })
  })
})

describe('isHistoricalMonth', () => {
  it('is false for the current month — it must always be live', () => {
    expect(isHistoricalMonth('2026-09', '2026-09')).toBe(false)
  })
  it('is true for any earlier month', () => {
    expect(isHistoricalMonth('2026-08', '2026-09')).toBe(true)
    expect(isHistoricalMonth('2024-12', '2026-09')).toBe(true)
  })
  it('is false for a future month, which cannot be closed', () => {
    expect(isHistoricalMonth('2026-10', '2026-09')).toBe(false)
  })
})

describe('the two fields the dashboard needs beyond value and count', () => {
  it('tracks billable revenue separately from work done', () => {
    // `revenue` is kept at month level rather than summed from byClient,
    // because a task with no client still earns and would vanish from that sum.
    const out = aggregateByMonth([
      task({ billing_amount_inr: 1000, is_billable: true, client: null }),
      task({ billing_amount_inr: 400, is_billable: false }),
    ])
    expect(out[0].taskValue).toBe(1400)
    expect(out[0].revenue).toBe(1000)
    // And this is exactly why `revenue` is not derived from byClient: the
    // billable task had no client, the waived one did, so summing byClient
    // would report ₹0 revenue for a month that earned ₹1,000.
    expect(out[0].byClient.reduce((s, c) => s + c.revenue, 0)).toBe(0)
  })

  it('counts creatives by quantity, not by rows', () => {
    const out = aggregateByMonth([
      task({ quantity: 5 }),
      task({ quantity: 3 }),
    ])
    expect(out[0].taskCount).toBe(2)
    expect(out[0].creativeCount).toBe(8)
  })

  it('treats a task with no quantity as one creative, like the live counter', () => {
    const out = aggregateByMonth([task({ quantity: null }), task({ quantity: undefined })])
    expect(out[0].creativeCount).toBe(2)
  })

  it('carries both through a merge', () => {
    const months = aggregateByMonth([
      task({ task_date: '2026-01-05', billing_amount_inr: 100, quantity: 2 }),
      task({ task_date: '2026-02-05', billing_amount_inr: 200, quantity: 3, is_billable: false }),
    ])
    const merged = mergeMonths(months)
    expect(merged.revenue).toBe(100)
    expect(merged.creativeCount).toBe(5)
  })
})

describe('day totals — what the trend graph and short date filters need', () => {
  it('totals each day that had work, in order', () => {
    const out = aggregateByMonth([
      task({ task_date: '2026-03-02', billing_amount_inr: 100, quantity: 2 }),
      task({ task_date: '2026-03-01', billing_amount_inr: 300, quantity: 1 }),
      task({ task_date: '2026-03-02', billing_amount_inr: 50, quantity: 4 }),
    ])
    expect(out[0].days).toEqual([
      { date: '2026-03-01', value: 300, count: 1, quantity: 1 },
      { date: '2026-03-02', value: 150, count: 2, quantity: 6 },
    ])
  })

  it('lists only days that had work, so an idle month stays small', () => {
    const out = aggregateByMonth([task({ task_date: '2026-03-15' })])
    expect(out[0].days).toHaveLength(1)
  })

  it('day totals reconcile with the month they belong to', () => {
    // If these ever disagreed, the trend graph and the headline figure would
    // contradict each other on the same screen.
    const out = aggregateByMonth([
      task({ task_date: '2026-03-01', billing_amount_inr: 100, quantity: 2 }),
      task({ task_date: '2026-03-09', billing_amount_inr: 250, quantity: 1 }),
      task({ task_date: '2026-03-20', billing_amount_inr: 75.5, quantity: 3 }),
    ])
    const m = out[0]
    expect(m.days.reduce((s, d) => s + d.value, 0)).toBeCloseTo(m.taskValue, 2)
    expect(m.days.reduce((s, d) => s + d.count, 0)).toBe(m.taskCount)
    expect(m.days.reduce((s, d) => s + d.quantity, 0)).toBe(m.creativeCount)
  })

  it('keeps days in date order across a merged range', () => {
    const months = aggregateByMonth([
      task({ task_date: '2026-02-20' }),
      task({ task_date: '2026-01-10' }),
      task({ task_date: '2026-03-05' }),
    ])
    const merged = mergeMonths(months)
    expect(merged.days.map(d => d.date)).toEqual(['2026-01-10', '2026-02-20', '2026-03-05'])
  })

  it('carries no client, service or employee detail per day', () => {
    // Deliberate: a per-day client split would multiply the payload by every
    // client who worked that day, and nothing reads it.
    const out = aggregateByMonth([task()])
    expect(Object.keys(out[0].days[0]).sort()).toEqual(['count', 'date', 'quantity', 'value'])
  })
})
