import { describe, it, expect, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'

vi.mock('next/headers', () => ({ cookies: () => ({}) }))

import { fetchAll, cloneQuery } from './server'

/**
 * fetchAll pages a table past PostgREST's 1,000-row cap, and since Nov 2026 it
 * requests the later pages TOGETHER by copying the query builder.
 *
 * That copy reaches into supabase-js: it relies on a builder keeping its
 * request in a `URL` and a `Headers` and nothing else mutable. A shared URL
 * between two "copies" is exactly the bug that silently dropped rows the first
 * time parallel paging was tried, and the callers include payroll, commission
 * and every money report — a short read there restates money without an error.
 *
 * So these run against the REAL library, with only the network replaced: a
 * fake PostgREST that serves a numbered table and honours `offset`/`limit`.
 * If an upgrade changes the builder so a copy is no longer independent, the
 * row-for-row assertions here fail instead of production.
 */

interface Call { offset: number; limit: number; order: string | null; filter: string | null }

function fakePostgrest(rowCount: number, opts: { failOffset?: number; missing?: boolean; dropBodyOnceAt?: number; dropBodyAlwaysAt?: number } = {}) {
  const calls: Call[] = []
  let inFlight = 0
  let peak = 0
  const dropped = new Set<number>()
  /** A 200 whose body dies while being read — undici's "TypeError: terminated". */
  const cutOff = () => new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('terminated')) },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const limit = Number(url.searchParams.get('limit') ?? 1000)
    calls.push({ offset, limit, order: url.searchParams.get('order'), filter: url.searchParams.get('kind') })
    inFlight++
    peak = Math.max(peak, inFlight)
    // Later pages answer FIRST, so a result assembled in completion order
    // rather than page order would come out scrambled.
    await new Promise(r => setTimeout(r, Math.max(1, 30 - offset / 1000)))
    inFlight--
    if (opts.dropBodyAlwaysAt === offset) return cutOff()
    if (opts.dropBodyOnceAt === offset && !dropped.has(offset)) {
      dropped.add(offset)
      return cutOff()
    }
    if (opts.missing) {
      return new Response(JSON.stringify({ code: 'PGRST205', message: 'not found in schema cache' }), { status: 404, headers: { 'content-type': 'application/json' } })
    }
    if (opts.failOffset === offset) {
      return new Response(JSON.stringify({ code: 'XX000', message: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } })
    }
    const rows = []
    for (let i = offset; i < Math.min(offset + limit, rowCount); i++) rows.push({ id: i })
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const db = createClient('https://example.supabase.co', 'test-key', {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: fetchImpl as typeof fetch },
  })
  return { db, calls, peak: () => peak }
}

const offsets = (calls: Call[]) => calls.map(c => c.offset).sort((a, b) => a - b)

describe('cloneQuery', () => {
  it('copies a real builder so paging one copy cannot move another', () => {
    const { db } = fakePostgrest(0)
    const original = db.from('things').select('id').eq('kind', 'a').order('id')
    const a = cloneQuery(original)!
    const b = cloneQuery(original)!
    expect(a).not.toBeNull()
    a.range(1000, 1999)
    b.range(2000, 2999)
    expect(a.url.searchParams.get('offset')).toBe('1000')
    expect(b.url.searchParams.get('offset')).toBe('2000')
    // The original was never paged, and the copies kept its filters.
    expect((original as unknown as { url: URL }).url.searchParams.has('offset')).toBe(false)
    expect(a.url.searchParams.get('kind')).toBe('eq.a')
    expect(b.url.searchParams.get('order')).toBe('id.asc')
  })

  it('refuses anything that is not that builder, so fetchAll falls back to sequential paging', () => {
    expect(cloneQuery(null)).toBeNull()
    expect(cloneQuery({ range() { return this } })).toBeNull()
    expect(cloneQuery({ url: new URL('https://x.test/rest/v1/t'), range() { return this } })).toBeNull()
  })
})

describe('fetchAll against the real supabase-js builder', () => {
  it('makes exactly one request for a table that fits in a page', async () => {
    const { db, calls } = fakePostgrest(412)
    const { data, error } = await fetchAll(db.from('things').select('id').order('id'))
    expect(error).toBeUndefined()
    expect(data).toHaveLength(412)
    expect(calls).toHaveLength(1)
  })

  it('returns every row of a six-page table once, in order, with later pages requested together', async () => {
    const { db, calls, peak } = fakePostgrest(5683)
    const { data, error } = await fetchAll(db.from('things').select('id').eq('kind', 'a').order('id'))
    expect(error).toBeUndefined()
    expect(data.map(r => r.id)).toEqual(Array.from({ length: 5683 }, (_, i) => i))
    // Page 0, then pages 1–2 together, then 3–6 together (page 6 is past the
    // end and comes back empty): three rounds where there used to be six.
    expect(offsets(calls)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000])
    expect(peak()).toBe(4)
    // Every page carried the caller's filter and order, not just the first.
    expect(calls.every(c => c.filter === 'eq.a' && c.order === 'id.asc')).toBe(true)
  })

  it('stops cleanly when the row count is an exact multiple of the page size', async () => {
    const { db, calls } = fakePostgrest(3000)
    const { data } = await fetchAll(db.from('things').select('id').order('id'))
    expect(data).toHaveLength(3000)
    expect(new Set(data.map(r => r.id)).size).toBe(3000)
    expect(offsets(calls)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000])
  })

  it('pages an UNORDERED query one request at a time, as before', async () => {
    const { db, calls, peak } = fakePostgrest(2500)
    const { data } = await fetchAll(db.from('things').select('id'))
    expect(data.map(r => r.id)).toEqual(Array.from({ length: 2500 }, (_, i) => i))
    expect(offsets(calls)).toEqual([0, 1000, 2000])
    expect(peak()).toBe(1)
  })

  it('reports a failed page and keeps only the rows before it', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = fakePostgrest(5683, { failOffset: 2000 })
    const { data, error } = await fetchAll(db.from('things').select('id').order('id'))
    expect(error).toBeTruthy()
    // Pages 0 and 1 only — nothing from after the failure, so a caller cannot
    // mistake a result with a hole in it for a complete one.
    expect(data.map(r => r.id)).toEqual(Array.from({ length: 2000 }, (_, i) => i))
    errorLog.mockRestore()
  })

  it('reads a missing table as empty, and remembers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { db, calls } = fakePostgrest(0, { missing: true })
    const first = await fetchAll(db.from('not_migrated_yet').select('id').order('id'))
    expect(first).toEqual({ data: [], error: undefined })
    await fetchAll(db.from('not_migrated_yet').select('id').order('id'))
    expect(calls).toHaveLength(1)
    warn.mockRestore()
  })
})

/**
 * A connection cut off mid-response. supabase-js retries a fetch that fails
 * to start but not one that dies while the body is read, so without a retry
 * here the page reads a table as shorter than it is and says nothing.
 */
describe('fetchAll when the connection drops mid-response', () => {
  it('asks for the page again and returns every row', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db, calls } = fakePostgrest(5683, { dropBodyOnceAt: 2000 })
    const { data, error } = await fetchAll(db.from('things').select('id').order('id'))
    expect(error).toBeUndefined()
    expect(data.map(r => r.id)).toEqual(Array.from({ length: 5683 }, (_, i) => i))
    // The cut-off page was requested twice; nothing else was.
    expect(calls.filter(c => c.offset === 2000)).toHaveLength(2)
    expect(calls.filter(c => c.offset === 1000)).toHaveLength(1)
    expect(errorLog).not.toHaveBeenCalled()
    errorLog.mockRestore()
  })

  it('retries the first page too', async () => {
    const { db, calls } = fakePostgrest(412, { dropBodyOnceAt: 0 })
    const { data, error } = await fetchAll(db.from('things').select('id').order('id'))
    expect(error).toBeUndefined()
    expect(data).toHaveLength(412)
    expect(calls).toHaveLength(2)
  })

  it('gives up after one retry and reports the failure', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db, calls } = fakePostgrest(5683, { dropBodyAlwaysAt: 1000 })
    const { data, error } = await fetchAll(db.from('things').select('id').order('id'))
    expect(error).toBeTruthy()
    expect(data).toHaveLength(1000)
    expect(calls.filter(c => c.offset === 1000)).toHaveLength(2)
    errorLog.mockRestore()
  })

  it('does not retry an error the database itself returned', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db, calls } = fakePostgrest(5683, { failOffset: 0 })
    const { error } = await fetchAll(db.from('things').select('id').order('id'))
    expect(error).toBeTruthy()
    expect(calls).toHaveLength(1)
    errorLog.mockRestore()
  })
})
