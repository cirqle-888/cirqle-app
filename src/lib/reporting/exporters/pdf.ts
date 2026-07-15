/**
 * PDF Exporter
 *
 * Every template renders as a rasterised, branded PDF — the shared layout
 * (Daily/Monthly's day/month table, or the "cards" system for the other six
 * templates) is drawn to one or more high-res A4 PNGs via Satori/`next/og`'s
 * `ImageResponse` and embedded full-page into a `jsPDF` document, so the PDF
 * always matches the WhatsApp/PNG image export exactly.
 *
 * Runs server-side (Node.js) — no browser APIs.
 */

import { jsPDF } from 'jspdf'
import type { RenderData } from '../types'
import { LAYOUT_KIND } from '../layouts/registry'
import { getReportFonts } from '../layouts/fonts'
import { measureElementHeight } from '../layouts/measure'

// A4 portrait at ~150 DPI: 1240 × 1754 design pixels (ratio 0.707 matches 210/297mm).
const RASTER_W = 1240
const RASTER_H = 1754
const PAGE_W_MM = 210
const PAGE_H_MM = 297

export async function generatePDF(data: RenderData): Promise<Buffer> {
  if (LAYOUT_KIND[data.template.name] === 'daily-style') {
    if (data.template.name === 'monthly') {
      const { computeMonthlyRows, buildMonthlyReportElement, buildMonthlyRowElement } = await import('../layouts/monthly-report')
      return generatePagedRasterPDF(data, { computeRows: computeMonthlyRows, buildElement: buildMonthlyReportElement, buildRowElement: buildMonthlyRowElement, rowNoun: 'Month' })
    }
    const { computeDailyRows, buildDailyReportElement, buildDailyRowElement } = await import('../layouts/daily-report')
    return generatePagedRasterPDF(data, { computeRows: computeDailyRows, buildElement: buildDailyReportElement, buildRowElement: buildDailyRowElement, rowNoun: 'Day' })
  }
  return generateCardsStylePDF(data)
}

/**
 * Real measured height (px) of the report's first data row — per-page row
 * counts derive from this instead of assuming single-line rows. Measured at
 * the page's real content width (page minus the safe-area side margins) with
 * the same fonts as the final render, so wrap points match exactly. Returns
 * undefined when there are no rows (capacity is moot).
 */
async function measureFirstRowPx<Row>(
  rows: Row[],
  buildRowElement: (row: Row, s: number) => React.ReactElement,
): Promise<number | undefined> {
  if (rows.length === 0) return undefined
  const { SAFE_AREA } = await import('../layouts/shared')
  const s = RASTER_W / 1080
  const contentW = Math.round(RASTER_W - (SAFE_AREA.left + SAFE_AREA.right) * s)
  return measureElementHeight(buildRowElement(rows[0], s), { width: contentW, fonts: getReportFonts() })
}

/**
 * How many data rows fit on one page, from REAL measurements of both the
 * page chrome (a `probe` render of the actual page with zero rows — includes
 * the safe-area padding, header, title, meta lines, table heading + header
 * row, footer, all with this report's real, possibly-wrapped names) and the
 * first data row. Replaces the fixed-estimate `reportTableRowCapacity` math,
 * which under-counted chrome whenever a long client/campaign/agency name
 * wrapped onto extra lines and let rows overflow into the footer.
 */
async function measuredRowCapacity(
  chromeProbe: React.ReactElement,
  rowPx: number | undefined,
): Promise<number> {
  if (rowPx === undefined) return 1
  const s = RASTER_W / 1080
  const chromePx = await measureElementHeight(chromeProbe, { width: RASTER_W, fonts: getReportFonts() })
  return Math.max(1, Math.floor((RASTER_H - chromePx - 10 * s) / rowPx)) // −10 safety
}

async function rasterToDataUrl(element: React.ReactElement): Promise<string> {
  const { ImageResponse } = await import('next/og')
  const response = new ImageResponse(element, { width: RASTER_W, height: RASTER_H, fonts: getReportFonts() })
  const png = Buffer.from(await (response as Response).arrayBuffer())
  return `data:image/png;base64,${png.toString('base64')}`
}

// ─── Daily / Monthly — paginated day/month table, image-based PDF ─────────────

interface RasterSource<Row> {
  computeRows: (data: RenderData) => Row[]
  buildElement: (data: RenderData, opts: {
    width: number; height: number; rows: Row[]; continuation: boolean; tableHeading?: string; probe?: boolean
  }) => React.ReactElement
  /** Renders one data row standalone, for real row-height measurement. */
  buildRowElement: (row: Row, s: number) => React.ReactElement
  rowNoun: 'Day' | 'Month'
}

/**
 * Renders a "daily-style" layout (full day/month table with a running
 * balance) to one or more high-resolution A4-portrait PNGs and embeds them
 * full-bleed as PDF pages — one page per chunk of rows, so the full campaign
 * history is shown instead of being truncated to the last few. Row counts
 * per page come from REAL measurements (`measuredRowCapacity`): page 1
 * keeps the full branded hero, continuation pages keep the header, compact campaign line,
 * repeated table header and footer. Shared between Daily and Monthly so
 * adding a third "daily-style" template in future needs no new page-stacking
 * logic — just a `computeRows`/`buildElement` pair.
 */
async function generatePagedRasterPDF<Row extends { date: string }>(
  data: RenderData,
  source: RasterSource<Row>,
): Promise<Buffer> {
  // Rows come back oldest → newest; reverse to newest-first so the report
  // reads like a statement, matching the WhatsApp/PNG export's own ordering.
  const allRows = source.computeRows(data).slice().reverse()
  const rowPx = await measureFirstRowPx(allRows, source.buildRowElement)
  const [firstCap, contCap] = await Promise.all([
    measuredRowCapacity(source.buildElement(data, { width: RASTER_W, height: RASTER_H, rows: [], continuation: false, probe: true }), rowPx),
    measuredRowCapacity(source.buildElement(data, { width: RASTER_W, height: RASTER_H, rows: [], continuation: true, probe: true }), rowPx),
  ])

  const pages: { rows: Row[]; startIndex: number; continuation: boolean }[] = []
  if (allRows.length <= firstCap) {
    pages.push({ rows: allRows, startIndex: 0, continuation: false })
  } else {
    pages.push({ rows: allRows.slice(0, firstCap), startIndex: 0, continuation: false })
    for (let i = firstCap; i < allRows.length; i += contCap) {
      pages.push({ rows: allRows.slice(i, i + contCap), startIndex: i, continuation: true })
    }
  }

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const noun = source.rowNoun === 'Day' ? 'Daily' : 'Monthly'

  for (let i = 0; i < pages.length; i++) {
    const { rows, startIndex, continuation } = pages[i]
    const tableHeading = pages.length > 1
      ? `${noun} Performance — ${source.rowNoun} ${startIndex + 1}–${startIndex + rows.length} of ${allRows.length}`
      : undefined

    const element = source.buildElement(data, { width: RASTER_W, height: RASTER_H, rows, continuation, tableHeading })
    const dataUrl = await rasterToDataUrl(element)

    if (i > 0) doc.addPage()
    doc.addImage(dataUrl, 'PNG', 0, 0, PAGE_W_MM, PAGE_H_MM, undefined, 'FAST')
  }

  return Buffer.from(doc.output('arraybuffer'))
}

// ─── Cards templates (Performance, Executive, Marketing, Lead Gen, ─────────────
// E-commerce, Agency) — same branded system, content-card pages instead of a
// day-by-day table, plus trailing table pages when `dailyBreakdown` is on.

async function generateCardsStylePDF(data: RenderData): Promise<Buffer> {
  const { paginateCardsForPDF, buildCardsPage } = await import('../layouts/report-cards')

  const cardPages = await paginateCardsForPDF(data, { width: RASTER_W, height: RASTER_H, fonts: getReportFonts() })
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  for (let i = 0; i < cardPages.length; i++) {
    const { continuation, keys } = cardPages[i]
    const element = buildCardsPage(data, { width: RASTER_W, height: RASTER_H, continuation, cardKeys: keys })
    const dataUrl = await rasterToDataUrl(element)
    if (i > 0) doc.addPage()
    doc.addImage(dataUrl, 'PNG', 0, 0, PAGE_W_MM, PAGE_H_MM, undefined, 'FAST')
  }

  // Trailing "Daily Breakdown" table pages — reuses Daily's own continuation-
  // page shape (header/compact-meta/table/footer) via `titleOverride` so the
  // title reads correctly for this template instead of "Meta Ads Daily
  // Report — continued".
  if (data.template.sections.dailyBreakdown) {
    const { computeDailyRows, buildDailyReportElement, buildDailyRowElement } = await import('../layouts/daily-report')

    const allRows = computeDailyRows(data).slice().reverse()
    const rowPx = await measureFirstRowPx(allRows, buildDailyRowElement)
    const contCap = await measuredRowCapacity(
      buildDailyReportElement(data, {
        width: RASTER_W, height: RASTER_H, rows: [], continuation: true, probe: true,
        titleOverride: `${data.template.displayName} — Daily Breakdown`,
      }),
      rowPx,
    )
    const rowChunks = allRows.length > 0
      ? Array.from({ length: Math.ceil(allRows.length / contCap) }, (_, i) => allRows.slice(i * contCap, (i + 1) * contCap))
      : [[]] // still render one page showing "No daily metrics recorded" rather than silently dropping the section

    for (let i = 0; i < rowChunks.length; i++) {
      const rows = rowChunks[i]
      const tableHeading = rowChunks.length > 1
        ? `Daily Breakdown — Day ${i * contCap + 1}–${i * contCap + rows.length} of ${allRows.length}`
        : undefined
      const element = buildDailyReportElement(data, {
        width: RASTER_W, height: RASTER_H, rows, continuation: true, tableHeading,
        titleOverride: `${data.template.displayName} — Daily Breakdown`,
      })
      const dataUrl = await rasterToDataUrl(element)
      doc.addPage()
      doc.addImage(dataUrl, 'PNG', 0, 0, PAGE_W_MM, PAGE_H_MM, undefined, 'FAST')
    }
  }

  return Buffer.from(doc.output('arraybuffer'))
}
