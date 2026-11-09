import { describe, it, expect, vi } from 'vitest'
import { planNextWindow, fetchAllParallel } from './server'

describe('planNextWindow', () => {
  it('asks for the first window when nothing has been fetched', () => {
    expect(planNextWindow([], 1000, 6)).toEqual({ done: false, keepPages: 0, nextPages: [0, 1, 2, 3, 4, 5] })
  })

  it('is done the moment any page comes back short', () => {
    // Six full pages would have meant a seventh request; a short fifth page
    // means pages 5+ are empty and are dropped unread.
    expect(planNextWindow([1000, 1000, 1000, 1000, 412, 0], 1000, 6)).toEqual({ done: true, keepPages: 5, nextPages: [] })
  })

  it('keeps everything up to and including the short page', () => {
    expect(planNextWindow([1000, 37], 1000, 6)).toEqual({ done: true, keepPages: 2, nextPages: [] })
    expect(planNextWindow([0], 1000, 6)).toEqual({ done: true, keepPages: 1, nextPages: [] })
  })

  it('asks for the next window when every page was full', () => {
    expect(planNextWindow([1000, 1000, 1000], 1000, 3)).toEqual({ done: false, keepPages: 3, nextPages: [3, 4, 5] })
  })
})

/** A factory of fake builders over `rows`, counting how many requests were made. */
function fakeTable(rows: { id: number }[], opts: { failPage?: number } = {}) {
  const calls: [number, number][] = []
  const makeQuery = () => ({
    url: new URL('https://x.test/rest/v1/things'),
    range(from: number, to: number) {
      calls.push([from, to])
      const page = from / 1000
      if (opts.failPage === page) return Promise.resolve({ data: null, error: { message: 'boom' } })
      return Promise.resolve({ data: rows.slice(from, to + 1), error: null })
    },
  })
  return { makeQuery, calls }
}
const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }))

describe('fetchAllParallel', () => {
  it('fetches a six-page table in one round of requests, in order, without duplicates', async () => {
    const { makeQuery, calls } = fakeTable(rowsOf(5658))
    const { data, error } = await fetchAllParallel(makeQuery, 6)
    expect(error).toBeUndefined()
    expect(data).toHaveLength(5658)
    expect(data[0].id).toBe(0)
    expect(data[5657].id).toBe(5657)
    expect(new Set(data.map(r => r.id)).size).toBe(5658)
    // All six pages were requested at once — the whole point.
    expect(calls).toHaveLength(6)
  })

  it('keeps asking in windows while every page is full', async () => {
    const { makeQuery, calls } = fakeTable(rowsOf(7_500))
    const { data } = await fetchAllParallel(makeQuery, 3)
    expect(data).toHaveLength(7_500)
    // 3 + 3 + 3 requests: the third window finds the short page.
    expect(calls).toHaveLength(9)
  })

  it('returns an empty table from a single short page', async () => {
    const { makeQuery, calls } = fakeTable([])
    const { data } = await fetchAllParallel(makeQuery, 6)
    expect(data).toEqual([])
    expect(calls).toHaveLength(6)
  })

  it('reports a failed page and keeps what was read before it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { makeQuery } = fakeTable(rowsOf(2500), { failPage: 1 })
    const { data, error } = await fetchAllParallel(makeQuery, 6)
    expect(error).toEqual({ message: 'boom' })
    // Page 0 is intact; the caller is told the result is partial.
    expect(data.length).toBeGreaterThanOrEqual(1000)
    warn.mockRestore()
  })
})
