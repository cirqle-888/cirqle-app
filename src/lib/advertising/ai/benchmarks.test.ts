/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
import { describe, it, expect, vi } from 'vitest'

const tables: Record<string, any[]> = {}
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: (t: string) => {
      const q: any = {
        select: () => q,
        in: async (col: string, vals: string[]) => ({ data: (tables[t] ?? []).filter(r => vals.includes(r[col])) }),
        eq: (col: string, v: string) => ({ maybeSingle: async () => ({ data: (tables[t] ?? []).find(r => r[col] === v) ?? null }) }),
        maybeSingle: async () => ({ data: (tables[t] ?? [])[0] ?? null }),
      }
      return q
    },
  }),
}))

import { chooseBenchmark, getBenchmarksForProjects, getBenchmarksWithSource } from './benchmarks'

describe('chooseBenchmark', () => {
  it('walks campaign → client → agency → placeholder', () => {
    expect(chooseBenchmark({ roas: 2, cpc: 1 }, null, null).source).toBe('campaign')
    expect(chooseBenchmark({ roas: 0 }, { roas: 3 }, null).source).toBe('client')
    expect(chooseBenchmark(null, null, { avg_roas: 1.2, avg_cpa: 50 })).toMatchObject({ source: 'agency', metrics: { cpa: 50 } })
    expect(chooseBenchmark(null, null, null).source).toBe('global')
  })
})

describe('batch lookup agrees with the single lookup', () => {
  it('returns the same tier and values per project', async () => {
    tables.mv_campaign_performance = [{ project_id: 'p1', roas: 2.5, cpc: 4, ctr: 1.1, cpa: 60 }]
    tables.mv_client_performance = [{ client_id: 'c2', roas: 1.8, cpa: 90 }]
    tables.mv_agency_benchmarks = [{ avg_roas: 1.4, avg_cpa: 75 }]
    const projects = [
      { id: 'p1', client_id: 'c1' }, // campaign tier
      { id: 'p2', client_id: 'c2' }, // client tier
      { id: 'p3', client_id: null }, // agency tier
    ]
    const batch = await getBenchmarksForProjects(projects)
    for (const p of projects) {
      expect(batch[p.id]).toEqual(await getBenchmarksWithSource(p.id, p.client_id ?? ''))
    }
    expect(Object.values(batch).map(b => b.source)).toEqual(['campaign', 'client', 'agency'])
  })
})
