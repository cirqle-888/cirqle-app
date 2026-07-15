/**
 * Unit tests for `paginateByRealHeight`'s bin-packing logic.
 *
 * Run with:  npx vitest run src/lib/reporting/layouts/paginate.test.ts
 *
 * Uses real (small, deterministic) Satori renders rather than a mocked
 * height-getter — `measureElementHeight` is a thin, single-purpose wrapper
 * with no branching logic of its own to fake; exercising the real
 * measurement path is cheap here (tiny fixed-height boxes) and gives higher
 * confidence than mocking would.
 */
import { describe, it, expect } from 'vitest'
import React from 'react'
import { paginateByRealHeight } from './paginate'

// A box with an EXPLICIT height (via a fixed-height inner div) so its
// measured height is deterministic and known ahead of time, regardless of
// font metrics — isolates the bin-packing algorithm from text measurement.
function box(height: number) {
  return React.createElement('div', { style: { display: 'flex', width: '400px', height: `${height}px`, background: '#fff' } })
}

describe('paginateByRealHeight', () => {
  it('packs items greedily onto pages without splitting any single item', async () => {
    // 5 items of height 100 each; page 1 budget 250 (fits 2), continuation budget 250 (fits 2 each).
    const items = [1, 2, 3, 4, 5]
    const pages = await paginateByRealHeight(items, {
      renderItem: () => box(100),
      width: 400,
      firstPageBudget: 250,
      continuationBudget: 250,
    })
    expect(pages.map(p => p.items)).toEqual([[1, 2], [3, 4], [5]])
    expect(pages[0].continuation).toBe(false)
    expect(pages[1].continuation).toBe(true)
    expect(pages[2].continuation).toBe(true)
  })

  it('returns a single page when everything fits on page 1', async () => {
    const items = ['a', 'b', 'c']
    const pages = await paginateByRealHeight(items, {
      renderItem: () => box(50),
      width: 400,
      firstPageBudget: 1000,
      continuationBudget: 1000,
    })
    expect(pages).toHaveLength(1)
    expect(pages[0]).toEqual({ continuation: false, items: ['a', 'b', 'c'] })
  })

  it('returns an empty array for no items', async () => {
    const pages = await paginateByRealHeight([], {
      renderItem: () => box(50),
      width: 400,
      firstPageBudget: 1000,
      continuationBudget: 1000,
    })
    expect(pages).toEqual([])
  })

  it('places a single oversized item alone rather than splitting or throwing', async () => {
    const items = ['huge']
    const pages = await paginateByRealHeight(items, {
      renderItem: () => box(5000), // taller than any page budget
      width: 400,
      firstPageBudget: 200,
      continuationBudget: 200,
    })
    expect(pages).toEqual([{ continuation: false, items: ['huge'] }])
  })

  it('defers an item too tall for page 1 to a roomier continuation page, leaving page 1 as a cover', async () => {
    // Page 1's full hero leaves only 150; continuation pages have 400.
    // Item A (300) can't fit page 1 even empty, but fits a continuation page
    // whole — so page 1 is emitted hero-only and A lands on page 2.
    const items = ['A', 'B']
    const heights: Record<string, number> = { A: 300, B: 80 }
    const pages = await paginateByRealHeight(items, {
      renderItem: item => box(heights[item as string]),
      width: 400,
      firstPageBudget: 150,
      continuationBudget: 400,
    })
    expect(pages.map(p => p.items)).toEqual([[], ['A', 'B']])
    expect(pages[0].continuation).toBe(false)
    expect(pages[1].continuation).toBe(true)
  })

  it('moves an oversized item to a fresh page rather than clipping it onto a partially-full page', async () => {
    // item A (100) fits on page 1 (budget 250), leaving 150 remaining —
    // item B (200) doesn't fit in the remaining 150, so it starts page 2.
    const items = ['A', 'B']
    const heights: Record<string, number> = { A: 100, B: 200 }
    const pages = await paginateByRealHeight(items, {
      renderItem: item => box(heights[item as string]),
      width: 400,
      firstPageBudget: 250,
      continuationBudget: 250,
    })
    expect(pages.map(p => p.items)).toEqual([['A'], ['B']])
  })
})
