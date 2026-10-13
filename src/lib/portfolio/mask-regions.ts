/**
 * Reading clickable areas out of a painted mask.
 *
 * `magicSelect` guesses where an element ends from the artwork alone, and on a
 * warm photographic composite it is often wrong — it cannot tell a bag from
 * the curtain behind it when both are the same dark red. A designer opening
 * that artwork in Photoshop can tell instantly, and can say so in thirty
 * seconds with the lasso and a fill.
 *
 * So: paint the areas you want on a copy of the artwork — black shapes on
 * white, magenta on black, anything — export it, and drop it in. Every painted
 * shape becomes one clickable area, in the right place, with the exact
 * outline. No guessing, and no limit on how awkward the shape is.
 *
 * ── WHAT COUNTS AS PAINTED ────────────────────────────────────────────────
 *
 * Deliberately not "a colour you configure". Two rules cover every way
 * somebody actually exports a mask:
 *
 *   · if the file has real transparency, the opaque pixels are the mask —
 *     which is what you get by deleting the background and exporting a PNG;
 *   · otherwise the single most common colour is the background and
 *     everything far enough from it is painted — which covers black on white,
 *     white on black, and the "rare colour" case of one bright shape on a
 *     copy of the artwork.
 *
 * Neither asks the user to tell us anything, and both are wrong in the same
 * obvious way (nothing found) rather than subtly.
 *
 * Pure and dependency-free; the caller supplies pixels.
 */

import type { HotspotPoint } from './hotspots'
import { traceBoundary, boundaryToPoints, type Bitmap } from './trace'

/** Below this share of the image a painted shape is a stray mark, not an area. */
const MIN_REGION_FRACTION = 0.0006
/** A pixel this far from the background colour counts as painted. */
const PAINT_DISTANCE = 60
/** Alpha at or above this is opaque enough to be part of the mask. */
const OPAQUE_ALPHA = 128
/** Transparency is "real" once this much of the image has it. */
const TRANSPARENCY_FRACTION = 0.02

export interface MaskRegionOptions {
  /** Stop after this many areas, largest first. Defaults to the format's 8. */
  maxRegions?: number
  maxPoints?: number
  /** Override the "stray mark" floor, as a fraction of the image. */
  minAreaFraction?: number
}

export interface MaskRegionResult {
  /** One polygon per painted shape, largest first. */
  regions: HotspotPoint[][]
  /** How the mask was read, so the UI can explain what it did. */
  mode: 'transparency' | 'colour'
  /** Shapes found but dropped for being too small — worth saying out loud. */
  ignoredSpecks: number
  /** Shapes found beyond `maxRegions`, likewise. */
  ignoredOverflow: number
}

/**
 * The background colour, read from the BORDER.
 *
 * Not the most common colour in the whole image: paint four big areas on a
 * mask and the paint outnumbers the background, so a global count names the
 * SHAPES as the background and then finds one enormous region with holes in
 * it. The edge of a mask is background essentially by definition — the same
 * reasoning as `backgroundColour` in offer-studio's cutout engine, which
 * samples a ring for exactly this reason.
 *
 * Bucketed to 32 levels per channel because a mask exported as JPEG has no
 * flat colours at all — its "white" is a thousand near-whites, and an exact
 * histogram would find no majority anywhere.
 */
function backgroundColour(bmp: Bitmap): [number, number, number] {
  const { data, width, height } = bmp
  const band = Math.max(1, Math.min(4, Math.floor(Math.min(width, height) / 8)))
  const counts = new Map<number, number>()
  for (let y = 0; y < height; y++) {
    const edgeRow = y < band || y >= height - band
    for (let x = 0; x < width; x++) {
      if (!(edgeRow || x < band || x >= width - band)) continue
      const i = y * width + x
      if (data[i * 4 + 3] < OPAQUE_ALPHA) continue
      const key = (data[i * 4] >> 3 << 10) | (data[i * 4 + 1] >> 3 << 5) | (data[i * 4 + 2] >> 3)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  let best = 0, bestCount = -1
  for (const [key, count] of counts) if (count > bestCount) { best = key; bestCount = count }
  // Back to the middle of the bucket.
  return [((best >> 10) & 31) * 8 + 4, ((best >> 5) & 31) * 8 + 4, (best & 31) * 8 + 4]
}

/** Which pixels are painted, by whichever rule this mask calls for. */
function paintedMask(bmp: Bitmap): { painted: Uint8Array; mode: 'transparency' | 'colour' } {
  const { data, width, height } = bmp
  const total = width * height
  const painted = new Uint8Array(total)

  let transparent = 0
  for (let i = 0; i < total; i++) if (data[i * 4 + 3] < OPAQUE_ALPHA) transparent++

  if (transparent / total >= TRANSPARENCY_FRACTION) {
    for (let i = 0; i < total; i++) painted[i] = data[i * 4 + 3] >= OPAQUE_ALPHA ? 1 : 0
    return { painted, mode: 'transparency' }
  }

  const [br, bg, bb] = backgroundColour(bmp)
  const limit = PAINT_DISTANCE * PAINT_DISTANCE
  for (let i = 0; i < total; i++) {
    const dr = data[i * 4] - br, dg = data[i * 4 + 1] - bg, db = data[i * 4 + 2] - bb
    painted[i] = dr * dr + dg * dg + db * db > limit ? 1 : 0
  }
  return { painted, mode: 'colour' }
}

/**
 * Split the painted pixels into separate shapes.
 *
 * Four-connected, so two shapes meeting only at a corner stay two areas —
 * which is what somebody who painted two posters meant, even if their
 * rectangles happen to touch.
 */
function components(painted: Uint8Array, width: number, height: number): Uint8Array[] {
  const seen = new Uint8Array(painted.length)
  const out: { mask: Uint8Array; size: number }[] = []
  const queue = new Int32Array(painted.length)

  for (let start = 0; start < painted.length; start++) {
    if (!painted[start] || seen[start]) continue
    const mask = new Uint8Array(painted.length)
    let head = 0, tail = 0, size = 0
    queue[tail++] = start
    seen[start] = 1
    while (head < tail) {
      const at = queue[head++]
      mask[at] = 1
      size++
      const x = at % width, y = (at / width) | 0
      if (x > 0 && painted[at - 1] && !seen[at - 1]) { seen[at - 1] = 1; queue[tail++] = at - 1 }
      if (x < width - 1 && painted[at + 1] && !seen[at + 1]) { seen[at + 1] = 1; queue[tail++] = at + 1 }
      if (y > 0 && painted[at - width] && !seen[at - width]) { seen[at - width] = 1; queue[tail++] = at - width }
      if (y < height - 1 && painted[at + width] && !seen[at + width]) { seen[at + width] = 1; queue[tail++] = at + width }
    }
    out.push({ mask, size })
  }
  // Largest first: if there are more shapes than slots, the big ones are the
  // ones somebody meant.
  out.sort((a, b) => b.size - a.size)
  return out.map(c => c.mask)
}

/**
 * Read every painted shape in a mask as a clickable area.
 *
 * Returns an empty `regions` list rather than throwing when the file is not a
 * usable mask — a photo with no flat background, or a blank canvas — so the
 * editor can say "nothing found here" instead of failing.
 */
export function detectMaskRegions(
  bmp: Bitmap, options: MaskRegionOptions = {},
): MaskRegionResult {
  const { width, height } = bmp
  const maxRegions = options.maxRegions ?? 8
  const empty: MaskRegionResult = { regions: [], mode: 'colour', ignoredSpecks: 0, ignoredOverflow: 0 }
  if (width < 2 || height < 2 || maxRegions < 1) return empty

  const { painted, mode } = paintedMask(bmp)
  const minPixels = Math.max(4, Math.floor(width * height * (options.minAreaFraction ?? MIN_REGION_FRACTION)))

  const all = components(painted, width, height)
  let ignoredSpecks = 0
  const regions: HotspotPoint[][] = []
  for (const mask of all) {
    let size = 0
    for (let i = 0; i < mask.length; i++) size += mask[i]
    if (size < minPixels) { ignoredSpecks++; continue }
    if (regions.length >= maxRegions) continue
    const points = boundaryToPoints(traceBoundary(mask, width, height), width, height, options.maxPoints)
    // A shape that survives the size floor but not the shape rules — a
    // one-pixel-wide line, say — is counted with the specks rather than
    // silently vanishing.
    if (points) regions.push(points)
    else ignoredSpecks++
  }
  const kept = regions.length
  const eligible = all.length - ignoredSpecks
  return {
    regions,
    mode,
    ignoredSpecks,
    ignoredOverflow: Math.max(0, eligible - kept),
  }
}
