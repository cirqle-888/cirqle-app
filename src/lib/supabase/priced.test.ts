import { describe, it, expect } from 'vitest'
import { isMissingPricedSource, viaPriced, type PricedSource } from './priced'

describe('isMissingPricedSource', () => {
  it('recognises the error PostgREST gives for a view that is not created yet', () => {
    // Captured from production on 2026-11-16, before 20261116110000 was applied.
    expect(isMissingPricedSource({
      code: 'PGRST205',
      message: "Could not find the table 'public.tasks_priced' in the schema cache",
    })).toBe(true)
    expect(isMissingPricedSource({ code: '42P01', message: 'relation "tasks_priced" does not exist' })).toBe(true)
    expect(isMissingPricedSource({ code: 'PGRST200', message: 'Could not find a relationship' })).toBe(true)
  })

  it('does not swallow real failures', () => {
    expect(isMissingPricedSource(null)).toBe(false)
    expect(isMissingPricedSource({ code: '42501', message: 'permission denied for table tasks' })).toBe(false)
    expect(isMissingPricedSource({ code: '22P02', message: 'invalid input syntax for type uuid' })).toBe(false)
  })
})

describe('viaPriced', () => {
  it('uses the priced views when they exist', async () => {
    const seen: PricedSource[] = []
    const res = await viaPriced(async src => { seen.push(src); return { data: [1], error: null } })
    expect(res.data).toEqual([1])
    expect(seen.map(s => s.tasks)).toEqual(['tasks_priced'])
  })

  it('falls back to the base tables only while the views are missing', async () => {
    const seen: string[] = []
    const res = await viaPriced(async src => {
      seen.push(src.scores)
      return src.scores === 'contribution_scores_priced'
        ? { data: null, error: { code: 'PGRST205', message: 'Could not find the table' } }
        : { data: [2], error: null }
    })
    expect(seen).toEqual(['contribution_scores_priced', 'contribution_scores'])
    expect(res.data).toEqual([2])
  })

  it('returns any other error from the view as it is, without retrying', async () => {
    let calls = 0
    const res = await viaPriced(async () => { calls++; return { data: null, error: { code: '42501', message: 'denied' } } })
    expect(calls).toBe(1)
    expect(res.error?.code).toBe('42501')
  })
})
