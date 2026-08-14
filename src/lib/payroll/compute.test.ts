import { describe, it, expect, vi, beforeEach } from 'vitest'
import { refreshMonthStoredEarnings } from './compute'

vi.mock('@/lib/supabase/server', () => ({
  fetchAll: vi.fn(async (query) => await query),
  // The mock chain ignores `.in()` and returns the whole table, so one call
  // with every id reproduces what the real chunk-and-page loop accumulates.
  fetchAllIn: vi.fn(async (makeQuery: (ids: string[]) => any, ids: string[]) =>
    ids?.length ? await makeQuery(ids) : { data: [] }
  ),
}))

function createMockAdmin(dataMap: Record<string, any>, updates: any[] = []) {
  const fromMock = vi.fn((table: string) => {
    const chain: any = {
      select: vi.fn(() => chain),
      gte: vi.fn(() => chain),
      lt: vi.fn(() => chain),
      is: vi.fn(() => chain),
      in: vi.fn(() => chain),
      eq: vi.fn((col, val) => {
        chain._eqs = chain._eqs || {}
        chain._eqs[col] = val
        return chain
      }),
      gt: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      update: vi.fn((payload) => {
        updates.push({ table, payload, _eqs: chain._eqs })
        return { error: null } // return promise-like
      }),
      then: (resolve: any) => {
        if (chain._isUpdate) {
          return resolve({ error: null })
        }
        return resolve(dataMap[table] || { data: [] })
      }
    }
    // intercept update to not resolve data but error
    const originalUpdate = chain.update
    chain.update = (payload: any) => {
      const entry = { table, payload, _eqs: {} }
      updates.push(entry)
      const uchain: any = {
        eq: vi.fn((col, val) => {
          entry._eqs[col] = val
          return uchain
        }),
        then: (resolve: any) => resolve({ error: null })
      }
      return uchain
    }
    return chain
  })

  return { from: fromMock } as any
}

describe('refreshMonthStoredEarnings', () => {
  it('computes earnings from billing_amount_inr × matrix commission %, skipping manual overrides', async () => {
    const updates: any[] = []

    const admin = createMockAdmin({
      payroll: { data: [] },
      period_locks: { data: [] },
      tasks: {
        data: [
          { id: 't1', billing_amount_inr: 2000, client_id: 'c1', service_id: 's1' },
          { id: 't2', billing_amount_inr: 3000, client_id: 'c2', service_id: 's2' },
          { id: 't3', billing_amount_inr: 1000, client_id: 'c1', service_id: 's1' },
        ]
      },
      contribution_scores: {
        data: [
          { task_id: 't1', employee_id: 'e1', score_percentage: 50, earnings_inr: 0, is_manual_override: false },
          { task_id: 't2', employee_id: 'e1', score_percentage: 50, earnings_inr: 0, is_manual_override: false },
          { task_id: 't3', employee_id: 'e1', score_percentage: 100, earnings_inr: 999, is_manual_override: true },
        ]
      },
      client_service_pricing: {
        data: [
          { client_id: 'c1', service_id: 's1', commission_percentage: 60 },
          { client_id: 'c2', service_id: 's2', commission_percentage: 80 },
        ]
      },
      employees: {
        data: [
          { id: 'e1', performance_rating: 100 },
        ]
      },
      task_tools: { data: [] },
      tools: { data: [] },
    }, updates)

    const res = await refreshMonthStoredEarnings(admin, '2026-01-01', '2026-02-01')

    expect(res.refreshed).toBe(2)

    // t1: pool = 2000 × 60% = 1200; earn = 1200 × 50% × 100% = 600
    const t1Update = updates.find(u => u._eqs.task_id === 't1')
    expect(t1Update.payload.earnings_inr).toBe(600)

    // t2: pool = 3000 × 80% = 2400; earn = 2400 × 50% × 100% = 1200
    const t2Update = updates.find(u => u._eqs.task_id === 't2')
    expect(t2Update.payload.earnings_inr).toBe(1200)

    // t3 is a manual override — never touched.
    expect(updates.find(u => u._eqs.task_id === 't3')).toBeUndefined()
  })

  it('falls back to 50% commission when no pricing row exists', async () => {
    const updates: any[] = []
    const admin = createMockAdmin({
      payroll: { data: [] },
      period_locks: { data: [] },
      tasks: { data: [{ id: 't1', billing_amount_inr: 1000, client_id: 'c1', service_id: 's1' }] },
      contribution_scores: {
        data: [{ task_id: 't1', employee_id: 'e1', score_percentage: 100, earnings_inr: 0, is_manual_override: false }]
      },
      client_service_pricing: { data: [] },
      employees: { data: [{ id: 'e1', performance_rating: 100 }] },
      task_tools: { data: [] },
      tools: { data: [] },
    }, updates)

    await refreshMonthStoredEarnings(admin, '2026-01-01', '2026-02-01')

    // pool = 1000 × 50% = 500; earn = 500 × 100% × 100% = 500
    expect(updates.find(u => u._eqs.task_id === 't1').payload.earnings_inr).toBe(500)
  })
})
