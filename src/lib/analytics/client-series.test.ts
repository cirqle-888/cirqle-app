/**
 * Per-client series. The bar is that these numbers agree with the rest of the
 * dashboard: the same task counted the same way, and the waived/billable
 * split kept exactly where historical.ts puts it.
 */
import { describe, it, expect } from 'vitest'
import {
  buildClientSeries, seriesTotals, rankClients, alignClientSeries, deltaPct,
  isMoneyMetric, type ClientTaskPoint,
} from './client-series'

const JULY = { from: '2026-07-01', to: '2026-07-31' }
const JUNE = { from: '2026-06-01', to: '2026-06-30' }

function task(p: Partial<ClientTaskPoint> & { date: string }): ClientTaskPoint {
  return { clientId: 'a', valueInr: 100, billable: true, quantity: 1, ...p }
}

describe('buildClientSeries', () => {
  it('buckets one client by day and leaves empty days at zero', () => {
    const s = buildClientSeries([task({ date: '2026-07-02', valueInr: 250 })], 'a', JULY, 'day')
    expect(s).toHaveLength(31)
    expect(s[1]).toMatchObject({ jobs: 1, valueInr: 250 })
    expect(s[0]).toMatchObject({ jobs: 0, valueInr: 0 })
  })

  it('counts only the client asked for', () => {
    const points = [task({ date: '2026-07-02' }), task({ date: '2026-07-02', clientId: 'b', valueInr: 999 })]
    expect(seriesTotals(buildClientSeries(points, 'a', JULY, 'day')))
      .toMatchObject({ jobs: 1, valueInr: 100 })
  })

  it('a null client is every client — the agency total', () => {
    const points = [task({ date: '2026-07-02' }), task({ date: '2026-07-03', clientId: 'b', valueInr: 50 })]
    expect(seriesTotals(buildClientSeries(points, null, JULY, 'day')))
      .toMatchObject({ jobs: 2, valueInr: 150 })
  })

  it('keeps waived work in value and out of revenue', () => {
    // The asymmetry historical.ts documents: work done is not money earned.
    const points = [
      task({ date: '2026-07-02', valueInr: 300, billable: true }),
      task({ date: '2026-07-03', valueInr: 200, billable: false }),
    ]
    expect(seriesTotals(buildClientSeries(points, 'a', JULY, 'day')))
      .toMatchObject({ jobs: 2, valueInr: 500, revenueInr: 300 })
  })

  it('counts creatives by quantity, not by row', () => {
    const points = [task({ date: '2026-07-02', quantity: 6 }), task({ date: '2026-07-04', quantity: 3 })]
    expect(seriesTotals(buildClientSeries(points, 'a', JULY, 'day')).creatives).toBe(9)
  })

  it('ignores tasks outside the period and undated ones', () => {
    const points = [
      task({ date: '2026-06-30' }), task({ date: '2026-08-01' }),
      { ...task({ date: '2026-07-05' }), date: null },
    ]
    expect(seriesTotals(buildClientSeries(points, 'a', JULY, 'day')).jobs).toBe(0)
  })

  it('buckets by month when the granularity says so', () => {
    const points = [task({ date: '2026-07-02' }), task({ date: '2026-07-20' })]
    const s = buildClientSeries(points, 'a', { from: '2026-01-01', to: '2026-12-31' }, 'month')
    expect(s).toHaveLength(12)
    expect(s[6]).toMatchObject({ key: '2026-07', jobs: 2 })
  })
})

describe('rankClients', () => {
  it('ranks on billable revenue, so waived work does not inflate a client', () => {
    const names = new Map([['a', 'Alpha'], ['b', 'Beta']])
    const points = [
      task({ date: '2026-07-02', clientId: 'a', valueInr: 1000, billable: false }),
      task({ date: '2026-07-02', clientId: 'b', valueInr: 400, billable: true }),
    ]
    const out = rankClients(points, JULY, names)
    expect(out.map(c => c.name)).toEqual(['Beta', 'Alpha'])
    expect(out[1]).toMatchObject({ name: 'Alpha', revenueInr: 0, jobs: 1 })
  })

  it('skips tasks with no client rather than inventing one', () => {
    const points = [{ ...task({ date: '2026-07-02' }), clientId: null }]
    expect(rankClients(points, JULY, new Map())).toEqual([])
  })

  it('names a client it has no name for, instead of showing a uuid', () => {
    const points = [task({ date: '2026-07-02', clientId: 'ghost' })]
    expect(rankClients(points, JULY, new Map())[0].name).toBe('Unknown client')
  })
})

describe('alignClientSeries', () => {
  it('lines the previous period up by index and prefixes the keys', () => {
    const cur = new Map([['a', buildClientSeries([task({ date: '2026-07-01', valueInr: 10 })], 'a', JULY, 'day')]])
    const prev = new Map([['a', buildClientSeries([task({ date: '2026-06-01', valueInr: 7 })], 'a', JUNE, 'day')]])
    const rows = alignClientSeries(cur, prev, 'valueInr')
    expect(rows[0].c_a).toBe(10)
    expect(rows[0].p_a).toBe(7)          // 1 June sits against 1 July
    expect(rows[0].label).toBe('1 Jul')
    expect(rows[0].prevLabel).toBe('1 Jun')
  })

  it('runs to the longer of the two periods', () => {
    const cur = new Map([['a', buildClientSeries([], 'a', JULY, 'day')]])   // 31
    const prev = new Map([['a', buildClientSeries([], 'a', JUNE, 'day')]])  // 30
    expect(alignClientSeries(cur, prev, 'jobs')).toHaveLength(31)
  })

  it('keeps each client in its own key', () => {
    const points = [task({ date: '2026-07-01', valueInr: 5 }), task({ date: '2026-07-01', clientId: 'b', valueInr: 9 })]
    const cur = new Map([
      ['a', buildClientSeries(points, 'a', JULY, 'day')],
      ['b', buildClientSeries(points, 'b', JULY, 'day')],
    ])
    const rows = alignClientSeries(cur, new Map(), 'valueInr')
    expect(rows[0]).toMatchObject({ c_a: 5, c_b: 9 })
  })

  it('has no rows when nothing is selected', () => {
    expect(alignClientSeries(new Map(), new Map(), 'jobs')).toEqual([])
  })
})

describe('deltaPct', () => {
  it('reports the change against the previous period', () => {
    expect(deltaPct(150, 100)).toBe(50)
    expect(deltaPct(50, 100)).toBe(-50)
  })
  it('refuses to divide by a zero baseline', () => {
    // "up ∞%" from nothing is noise, not information.
    expect(deltaPct(150, 0)).toBeNull()
    expect(deltaPct(150, null)).toBeNull()
  })
})

describe('isMoneyMetric', () => {
  it('knows which metrics carry rupees', () => {
    expect(isMoneyMetric('valueInr')).toBe(true)
    expect(isMoneyMetric('revenueInr')).toBe(true)
    expect(isMoneyMetric('jobs')).toBe(false)
    expect(isMoneyMetric('creatives')).toBe(false)
  })
})
