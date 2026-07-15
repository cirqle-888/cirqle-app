/**
 * Generic, measurement-driven pagination — the reusable layout utility every
 * report template inherits instead of hand-tuning its own magic-number
 * height budgets. Generalizes the greedy bin-packing loop that used to be
 * hard-coded inside `paginateCardsForPDF` (report-cards.tsx), parameterized
 * by an async height-getter so it works for cards, table rows, or any future
 * paginatable content.
 *
 * An item is never split across pages — if it doesn't fit the remaining
 * budget it moves whole to the next page (requirement: a card/row that can't
 * fit is relocated, never clipped).
 */

import type React from 'react'
import { measureElementHeight } from './measure'
import type { ReportFont } from './measure'

export interface PageBucket<T> { continuation: boolean; items: T[] }

export interface PaginateOpts<T> {
  renderItem: (item: T) => React.ReactElement
  /** Real target canvas width in pixels (1080 for images, 1240 for the A4
   * PDF raster) — measurement must use the actual export width, not a
   * normalized design-unit space, since real text wrapping depends on real
   * pixel width. */
  width: number
  /** Real px available on page 1 (canvas height minus chrome). */
  firstPageBudget: number
  /** Real px available on continuation pages. */
  continuationBudget: number
  fonts: ReportFont[]
}

export async function paginateByRealHeight<T>(items: T[], opts: PaginateOpts<T>): Promise<PageBucket<T>[]> {
  if (items.length === 0) return []

  // Every item's own height is independent of which page it lands on, so
  // measure them all in parallel rather than serially.
  const heights = await Promise.all(
    items.map(item => measureElementHeight(opts.renderItem(item), { width: opts.width, fonts: opts.fonts })),
  )

  const pages: PageBucket<T>[] = []
  let current: T[] = []
  let currentBudget = opts.firstPageBudget
  let isFirstPage = true

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const h = heights[i]

    if (current.length > 0 && h > currentBudget) {
      pages.push({ continuation: !isFirstPage, items: current })
      current = []
      isFirstPage = false
      currentBudget = opts.continuationBudget
    }

    // An item too tall even for an EMPTY first page (page 1's full hero
    // leaves less room) gets deferred to a continuation page when that page
    // is roomier — page 1 then acts as a hero-only cover page instead of
    // rendering the item clipped.
    if (current.length === 0 && isFirstPage && h > currentBudget && opts.continuationBudget > currentBudget) {
      pages.push({ continuation: false, items: [] })
      isFirstPage = false
      currentBudget = opts.continuationBudget
    }

    // Defensive last resort: a single item taller than an entire empty page
    // still gets placed alone (never split) rather than crash generation —
    // observable in server logs without breaking the report.
    if (current.length === 0 && h > currentBudget) {
      console.warn(`[paginateByRealHeight] item ${i} (${Math.round(h)}px) exceeds the full page budget (${Math.round(currentBudget)}px) — placing it alone; it may render tighter than usual.`)
    }

    current.push(item)
    currentBudget -= h
  }

  if (current.length > 0 || pages.length === 0) {
    pages.push({ continuation: !isFirstPage, items: current })
  }

  return pages
}
