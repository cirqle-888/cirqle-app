import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/supabase/server', () => ({ fetchAll: async () => ({ data: [] }) }))

import { monthsBetween, analyticsMonthTag, ANALYTICS_TAG, ANALYTICS_TTL_SECONDS } from './cache'

describe('the cache window', () => {
  it('lists every month up to but EXCLUDING the current one', () => {
    // Exclusive because the last entry is the live month, which never caches.
    expect(monthsBetween('2026-06', '2026-09')).toEqual(['2026-06', '2026-07', '2026-08'])
  })

  it('crosses a year boundary', () => {
    expect(monthsBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01'])
  })

  it('is empty when there is no history yet', () => {
    expect(monthsBetween('2026-09', '2026-09')).toEqual([])
  })

  it('is empty rather than endless for a reversed window', () => {
    expect(monthsBetween('2026-09', '2026-06')).toEqual([])
  })

  it('is empty for malformed input rather than guessing', () => {
    expect(monthsBetween('nope', '2026-09')).toEqual([])
    expect(monthsBetween('2026-09', '')).toEqual([])
  })

  it('covers a 36-month window without truncating it', () => {
    expect(monthsBetween('2023-09', '2026-09')).toHaveLength(36)
  })

  it('is bounded, so a bad input cannot spin', () => {
    expect(monthsBetween('1900-01', '2100-01').length).toBeLessThanOrEqual(120)
  })
})

describe('tags and TTL', () => {
  it('gives each month its own tag, so one correction does not clear 35 others', () => {
    expect(analyticsMonthTag('2026-03')).toBe('analytics-month-2026-03')
    expect(analyticsMonthTag('2026-03')).not.toBe(analyticsMonthTag('2026-04'))
  })

  it('keeps a 24-hour TTL as the safety net under explicit invalidation', () => {
    // Point 7: every write path being hooked is a claim nobody can fully
    // verify, so the TTL bounds how wrong a missed hook can leave us.
    expect(ANALYTICS_TTL_SECONDS).toBe(86400)
  })

  it('has a blanket tag for bulk changes', () => {
    expect(ANALYTICS_TAG).toBe('analytics-historical')
  })
})
