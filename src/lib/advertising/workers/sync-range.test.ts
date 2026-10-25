import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/jobs/engine', () => ({ enqueueJob: async () => 'x' }))
vi.mock('@/lib/advertising/providers', () => ({ getProvider: () => ({}) }))
vi.mock('@/lib/advertising/pipeline', () => ({ ingestMetrics: async () => ({}) }))
vi.mock('@/lib/integrations/tokens', () => ({ decryptToken: () => 't' }))
import { syncRange } from './sync'

const now = new Date('2026-10-25T06:00:00Z') // 25 Oct in India

describe('syncRange', () => {
  it('defaults to the trailing 7 days', () => {
    expect(syncRange({}, now)).toEqual({ startDate: '2026-10-18', endDate: '2026-10-25' })
  })
  it('accepts a backfill range and clamps the end to today', () => {
    expect(syncRange({ start_date: '2026-08-01', end_date: '2026-12-01' }, now)).toEqual({ startDate: '2026-08-01', endDate: '2026-10-25' })
  })
  it('rejects bad or oversized ranges', () => {
    expect('error' in syncRange({ start_date: 'yesterday' }, now)).toBe(true)
    expect('error' in syncRange({ start_date: '2026-10-20', end_date: '2026-10-01' }, now)).toBe(true)
    expect('error' in syncRange({ start_date: '2023-01-01' }, now)).toBe(true)
  })
})
