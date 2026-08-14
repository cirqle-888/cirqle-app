import { describe, it, expect, vi } from 'vitest'

vi.mock('next/headers', () => ({ cookies: () => ({}) }))

import { fetchAllIn } from './server'

/**
 * These guard the two ceilings a bare `.in(column, ids)` silently hits: the
 * request-URL length (too many ids) and PostgREST's 1,000-row response cap
 * (too many matching rows). Both lose rows without raising an error, and the
 * callers are payroll and commission recalculation — a short read there
 * restates money.
 */

/**
 * Minimal stand-in for a PostgREST builder: thenable, and `.range(from, to)`
 * slices the rows it was seeded with, exactly as the real one pages.
 */
function fakeQuery(rows: any[], onRange?: (from: number, to: number) => void) {
  const q: any = {
    tableName: 'contribution_scores',
    range(from: number, to: number) {
      onRange?.(from, to)
      q._slice = rows.slice(from, to + 1)
      return q
    },
    then(resolve: any) {
      return resolve({ data: q._slice ?? rows, error: null })
    },
  }
  return q
}

const row = (i: number) => ({ id: `r${i}` })

describe('fetchAllIn', () => {
  it('chunks the id list so the request URL cannot overflow', async () => {
    const seen: string[][] = []
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`)

    await fetchAllIn(chunk => { seen.push(chunk); return fakeQuery([]) }, ids, 100)

    expect(seen.map(c => c.length)).toEqual([100, 100, 50])
    // Every id is asked for exactly once — no chunk boundary drops one.
    expect(seen.flat()).toEqual(ids)
  })

  it('pages past the 1,000-row cap within a single chunk', async () => {
    // One chunk of ids matching 1,750 rows — a bare .in() would return 1,000.
    const rows = Array.from({ length: 1750 }, (_, i) => row(i))
    const { data } = await fetchAllIn(() => fakeQuery(rows), ['a'], 100)

    expect(data).toHaveLength(1750)
    expect(data[1749]).toEqual(row(1749))
  })

  it('accumulates rows across every chunk', async () => {
    const perChunk = new Map<string, any[]>([
      ['a', [row(1), row(2)]],
      ['b', [row(3)]],
    ])
    const { data } = await fetchAllIn(chunk => fakeQuery(perChunk.get(chunk[0]) ?? []), ['a', 'b'], 1)

    expect(data).toEqual([row(1), row(2), row(3)])
  })

  it('de-duplicates ids rather than fetching the same rows twice', async () => {
    const seen: string[][] = []
    await fetchAllIn(chunk => { seen.push(chunk); return fakeQuery([]) }, ['a', 'b', 'a', 'b'], 100)

    expect(seen).toEqual([['a', 'b']])
  })

  it('makes no request at all for an empty or missing id list', async () => {
    const make = vi.fn(() => fakeQuery([row(1)]))

    expect(await fetchAllIn(make, [], 100)).toEqual({ data: [] })
    expect(await fetchAllIn(make, undefined as any, 100)).toEqual({ data: [] })
    expect(make).not.toHaveBeenCalled()
  })

  it('builds a fresh query per chunk — a PostgREST builder cannot be reused', async () => {
    const built: any[] = []
    await fetchAllIn(() => { const q = fakeQuery([]); built.push(q); return q }, ['a', 'b'], 1)

    expect(built).toHaveLength(2)
    expect(built[0]).not.toBe(built[1])
  })
})
