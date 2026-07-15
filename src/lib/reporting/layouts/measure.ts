/**
 * Real text/layout measurement for the branded reporting engine.
 *
 * Pagination used to be decided from hand-tuned magic-number height
 * estimates (`CARD_HEIGHT_BUDGETS`, a flat `ROW_H` constant) because it was
 * believed Satori "doesn't expose measured layout back to the caller." That's
 * wrong at the Satori-library level: `satori(jsx, { width })` — height
 * omitted — has Yoga auto-compute real content height for that width, with
 * real font-metric-accurate line wrapping.
 *
 * IMPORTANT: `next/og`'s `ImageResponse` does NOT expose this. Confirmed by
 * direct testing — `new ImageResponse(jsx, { width })` with height omitted
 * silently falls back to Next's Open-Graph-image default height (630px,
 * i.e. the standard 1200×630 OG convention) regardless of actual content, so
 * it cannot be used for measurement. This module instead uses the public
 * `satori` package directly (the same underlying renderer, confirmed via
 * direct testing to return real, content-responsive heights), passing the
 * SAME local font files used everywhere else in this engine so measured
 * wrap points always match final `ImageResponse` render output exactly.
 */

import type React from 'react'
import satori from 'satori'
import type { Font } from 'satori'

export type ReportFont = Font

export interface MeasureOpts {
  /** Target canvas width in real pixels — measurement must use the ACTUAL
   * export width (1080 for images, 1240 for the A4 PDF raster), not a
   * normalized design-unit space, since real text wrapping depends on real
   * pixel width. */
  width: number
  fonts: ReportFont[]
}

/**
 * Renders `element` standalone at `opts.width` with height omitted, and
 * returns its true auto-computed height in pixels — read directly from the
 * returned SVG's own `height` attribute.
 */
export async function measureElementHeight(element: React.ReactElement, opts: MeasureOpts): Promise<number> {
  const svg = await satori(element, { width: opts.width, fonts: opts.fonts })
  const match = svg.match(/<svg[^>]*\sheight="([\d.]+)"/)
  if (!match) throw new Error('[measureElementHeight] could not read height from Satori SVG output')
  return Math.ceil(parseFloat(match[1]))
}
