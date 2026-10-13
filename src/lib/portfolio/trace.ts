/**
 * Picking an element out of the artwork, instead of tracing it by hand.
 *
 * The hotspot editor's two ways of making a shape both put the work on the
 * person: "Draw outline" wants 3–16 clicks placed accurately around a poster
 * with no way to adjust one afterwards except typing numbers, and "Add
 * rectangle" drops a fixed 35–65% box in the middle that has to be typed into
 * position. On a composite like the Elara artwork — a bottle, two bags, a
 * backdrop — getting a clean outline that way takes a dozen attempts.
 *
 * So: click inside the poster and let the image say where its edges are.
 * `magicSelect` grows a region from that point while the colour stays close
 * to it, traces the region's outline, and simplifies that outline to
 * something the stored format can hold.
 *
 * ── WHAT THE FORMAT ALLOWS, AND WHY IT SHAPES ALL OF THIS ─────────────────
 *
 * `validHotspots` accepts 3 to 256 points (manual/magic outlines default to 16), each 0–100 as a percentage of the
 * ORIGINAL image, and rejects a shape whose shoelace area is 2 or less. A
 * traced boundary has hundreds of points, so simplification is not a nicety
 * here — an unsimplified trace is simply not storable. Everything below
 * returns either a polygon that satisfies those rules or `null`; it never
 * returns something the validator would reject.
 *
 * ── HONEST LIMITS ─────────────────────────────────────────────────────────
 *
 * This is colour-similarity region growing, not object recognition. It is
 * good at a poster, a bag or a label that sits against a contrasting
 * background, and poor at an object that fades into what is behind it or is
 * split by a strong highlight. That is why `tolerance` is a control the user
 * turns rather than a constant, why a failed selection returns `null` so the
 * UI can say so plainly, and why the drag and drag-a-vertex paths exist
 * beside it rather than being replaced by it.
 *
 * Pure and dependency-free: no canvas, no DOM. The caller supplies pixels.
 */

import type { HotspotPoint } from './hotspots'

/** Max points the stored format accepts. */
const MAX_POINTS = 16
/** Min points a polygon needs. */
const MIN_POINTS = 3
/**
 * Minimum shoelace area, in percent², that `validHotspots` demands.
 * Kept a little above its `> 2` so a rounding step cannot land exactly on it.
 */
const MIN_AREA = 2.5

/**
 * A selection covering most of the frame is the backdrop, not an element.
 *
 * Measured against real artwork rather than guessed: on a photographic
 * composite a mid tolerance floods every dark tone at once, and the first
 * cap of 0.9 let a selection through that ran 0→100 on both axes.
 */
const MAX_COVERAGE = 0.75
/** Below this the region is a speck — a highlight or a bit of noise. */
const MIN_COVERAGE = 0.0004

export interface Bitmap {
  /** RGBA, 4 bytes per pixel, row-major — exactly what `getImageData` gives. */
  data: Uint8ClampedArray
  width: number
  height: number
}

/** Shoelace area of a polygon. Sign ignored; winding does not matter here. */
export function polygonArea(points: readonly HotspotPoint[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]
    const [x2, y2] = points[(i + 1) % points.length]
    sum += x1 * y2 - x2 * y1
  }
  return Math.abs(sum) / 2
}

const clampPercent = (n: number) => Math.max(0, Math.min(100, n))
/**
 * Two decimals, the precision the stored format keeps.
 *
 * Epsilon-guarded, the same way `round2` in calculations/currency.ts is: the
 * naive `Math.round(n * 100) / 100` puts 1.005 at 100.49999999999999 once
 * multiplied and rounds it DOWN. That module is the money rounder and this
 * one is deliberately dependency-free geometry, so the shape of the fix is
 * shared rather than the import — and the repo's round2 guard checks for the
 * unguarded PATTERN, which is the thing actually worth preventing.
 */
const roundPercent = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * A rectangle from a drag, as four points.
 *
 * Normalised, so dragging up-left works exactly like dragging down-right, and
 * floored at a size that survives the area check — a stray click that moves
 * two pixels should become a usable box rather than a rejected sliver.
 */
export function rectangleFromDrag(
  x0: number, y0: number, x1: number, y1: number,
): HotspotPoint[] {
  const minSize = 2
  let left = clampPercent(Math.min(x0, x1))
  let top = clampPercent(Math.min(y0, y1))
  let right = clampPercent(Math.max(x0, x1))
  let bottom = clampPercent(Math.max(y0, y1))

  // Grow a too-small box rather than refusing it, keeping it inside the image.
  if (right - left < minSize) {
    if (left + minSize <= 100) right = left + minSize
    else left = (right = 100) - minSize
  }
  if (bottom - top < minSize) {
    if (top + minSize <= 100) bottom = top + minSize
    else top = (bottom = 100) - minSize
  }
  return [[left, top], [right, top], [right, bottom], [left, bottom]].map(
    p => [roundPercent(p[0]), roundPercent(p[1])] as HotspotPoint,
  )
}

/**
 * Move a whole shape, stopping at the edges of the image.
 *
 * The shape is shifted as one — it is clamped by how far it CAN go, not by
 * clamping each point, which would deform it against an edge.
 */
export function movePolygon(
  points: readonly HotspotPoint[], dx: number, dy: number,
): HotspotPoint[] {
  const xs = points.map(p => p[0])
  const ys = points.map(p => p[1])
  const shiftX = Math.max(-Math.min(...xs), Math.min(dx, 100 - Math.max(...xs)))
  const shiftY = Math.max(-Math.min(...ys), Math.min(dy, 100 - Math.max(...ys)))
  return points.map(p => [roundPercent(p[0] + shiftX), roundPercent(p[1] + shiftY)] as HotspotPoint)
}

/** Move one vertex, clamped to the image. */
export function movePoint(
  points: readonly HotspotPoint[], index: number, x: number, y: number,
): HotspotPoint[] {
  return points.map((p, i) =>
    i === index ? [roundPercent(clampPercent(x)), roundPercent(clampPercent(y))] as HotspotPoint : p)
}

// ── Magic select ───────────────────────────────────────────────────────────

/** Does the mask reach all four sides of the image? */
function touchesEveryEdge(mask: Uint8Array, width: number, height: number): boolean {
  let top = false, bottom = false, left = false, right = false
  for (let x = 0; x < width; x++) {
    if (mask[x]) top = true
    if (mask[(height - 1) * width + x]) bottom = true
  }
  for (let y = 0; y < height; y++) {
    if (mask[y * width]) left = true
    if (mask[y * width + width - 1]) right = true
  }
  return top && bottom && left && right
}

/**
 * Edge strength per pixel, as a Sobel magnitude over luminance.
 *
 * Colour similarity to the SEED is not enough on photographic artwork. A warm
 * composite — a bottle against a curtain against a backdrop, all in the same
 * dark reds — has no single colour step large enough to stop a fill, so the
 * region creeps across a gradient and ends up taking half the frame. Measured
 * on the real Elara artwork: at every tolerance that still found the bottle,
 * the fill had already leaked into the curtain.
 *
 * An edge barrier fixes the thing that actually goes wrong. Two regions may
 * be a similar shade and still have a hard boundary between them, and that
 * boundary is where the fill has to stop.
 */
function edgeMap(bmp: Bitmap): Float32Array {
  const { data, width, height } = bmp
  const luma = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++) {
    luma[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
  }
  const out = new Float32Array(width * height)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const gx =
        -luma[i - width - 1] - 2 * luma[i - 1] - luma[i + width - 1]
        + luma[i - width + 1] + 2 * luma[i + 1] + luma[i + width + 1]
      const gy =
        -luma[i - width - 1] - 2 * luma[i - width] - luma[i - width + 1]
        + luma[i + width - 1] + 2 * luma[i + width] + luma[i + width + 1]
      out[i] = Math.hypot(gx, gy)
    }
  }
  return out
}

/** Squared RGB distance; square roots are not worth it for a comparison. */
function colourDistanceSq(
  data: Uint8ClampedArray, a: number, b: number,
): number {
  const dr = data[a] - data[b]
  const dg = data[a + 1] - data[b + 1]
  const db = data[a + 2] - data[b + 2]
  return dr * dr + dg * dg + db * db
}

/**
 * Grow a mask from the seed while the colour stays within tolerance.
 *
 * Scanline fill rather than a per-pixel stack: a poster can be a few hundred
 * thousand pixels, and pushing each one individually is what makes a naive
 * magic wand feel slow enough to look broken.
 */
function floodMask(
  bmp: Bitmap, seedX: number, seedY: number, threshold: number, edgeLimit: number,
): { mask: Uint8Array; filled: number } {
  const { data, width, height } = bmp
  const mask = new Uint8Array(width * height)
  const edges = edgeMap(bmp)
  const seed = (seedY * width + seedX) * 4
  const limit = threshold * threshold
  let filled = 0

  // Colour test AND edge test. Whether a pixel is already filled is a separate
  // question — folding that in breaks the row walk below, because a run that
  // is partly filled already would stop short.
  //
  // The seed itself is always admitted: clicking exactly on an edge (the rim
  // of a bottle, the fold of a bag) should still start a selection rather
  // than silently refusing.
  const similar = (x: number, y: number) => {
    const i = y * width + x
    if (i === seedY * width + seedX) return true
    if (edges[i] > edgeLimit) return false
    return colourDistanceSq(data, i * 4, seed) <= limit
  }

  const stack: [number, number][] = [[seedX, seedY]]
  while (stack.length) {
    const [sx, sy] = stack.pop()!
    if (mask[sy * width + sx] || !similar(sx, sy)) continue

    // Walk left and right from the seam to find this row's run.
    let left = sx
    while (left > 0 && similar(left - 1, sy)) left--
    let right = sx
    while (right < width - 1 && similar(right + 1, sy)) right++

    for (let x = left; x <= right; x++) {
      if (!mask[sy * width + x]) { mask[sy * width + x] = 1; filled++ }
    }

    // Seed the rows above and below, once per contiguous stretch.
    for (const ny of [sy - 1, sy + 1]) {
      if (ny < 0 || ny >= height) continue
      let inRun = false
      for (let x = left; x <= right; x++) {
        const ok = similar(x, ny) && !mask[ny * width + x]
        if (ok && !inRun) { stack.push([x, ny]); inRun = true }
        else if (!ok) inRun = false
      }
    }
  }
  return { mask, filled }
}

/**
 * Follow the outside of the mask, in order, with Moore-neighbour tracing.
 *
 * Returns the boundary pixels of the region containing the seed — the OUTER
 * boundary only, so a poster with a hole in it (a cut-out letter, a gap
 * between two bags) still yields one sane outline rather than several.
 */
export function traceBoundary(
  mask: Uint8Array, width: number, height: number,
): [number, number][] {
  const at = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1

  // Topmost-then-leftmost filled pixel: guaranteed to be on the outer edge,
  // and guaranteed to have an empty neighbour to its west.
  let startX = -1, startY = -1
  outer: for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) { startX = x; startY = y; break outer }
    }
  }
  if (startX < 0) return []

  // Clockwise with y pointing down: W, NW, N, NE, E, SE, S, SW.
  const ring = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]]

  const boundary: [number, number][] = []
  let cx = startX, cy = startY
  // Where to begin the sweep around the current pixel. It must start at the
  // BACKGROUND cell we arrived from — sweeping from the direction we moved in
  // sends the walk into the region's interior, which traces a 2×2 loop around
  // the start pixel and nothing else.
  let from = 0 // the west neighbour of the start pixel is background by construction
  const maxSteps = width * height * 4 // cannot spin forever on a torn mask

  for (let step = 0; step < maxSteps; step++) {
    boundary.push([cx, cy])
    let moved = false
    for (let i = 0; i < 8; i++) {
      const d = (from + i) % 8
      const nx = cx + ring[d][0]
      const ny = cy + ring[d][1]
      if (at(nx, ny)) {
        cx = nx
        cy = ny
        // The pixel we just left lies in the opposite direction from the new
        // one; resume the sweep one step past it.
        from = (d + 5) % 8
        moved = true
        break
      }
    }
    if (!moved) break                          // a single isolated pixel
    if (cx === startX && cy === startY) break  // closed the loop
  }
  return boundary
}

/** Perpendicular distance from a point to the line through a and b. */
function perpendicularDistance(
  p: [number, number], a: [number, number], b: [number, number],
): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / Math.hypot(dx, dy)
}

/** Ramer–Douglas–Peucker on an open run of points. */
function simplifyRun(
  points: [number, number][], epsilon: number,
): [number, number][] {
  if (points.length < 3) return points
  let worst = 0
  let index = 0
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], points[0], points[points.length - 1])
    if (d > worst) { worst = d; index = i }
  }
  if (worst <= epsilon) return [points[0], points[points.length - 1]]
  return [
    ...simplifyRun(points.slice(0, index + 1), epsilon).slice(0, -1),
    ...simplifyRun(points.slice(index), epsilon),
  ]
}

/**
 * Reduce a traced boundary to at most `MAX_POINTS`.
 *
 * The tolerance is raised until it fits rather than guessed once: the right
 * epsilon depends on how big and how intricate the region is, and a fixed one
 * either mangles a simple rectangle or fails to simplify a ragged outline
 * enough to be storable.
 */
export function simplifyToLimit(
  boundary: readonly [number, number][], max = MAX_POINTS,
): [number, number][] {
  if (boundary.length <= max) return [...boundary]
  const xs = boundary.map(p => p[0])
  const ys = boundary.map(p => p[1])
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))

  let epsilon = Math.max(span / (max > 16 ? 4000 : 200), 0.0001)
  let simplified = [...boundary]
  // Doubling converges in a handful of rounds for any real outline; the cap
  // is a guard, not an expected path.
  for (let i = 0; i < 40 && simplified.length > max; i++) {
    simplified = simplifyRun([...boundary], epsilon)
    epsilon *= 1.6
  }
  // Still too many after the cap: keep an evenly spaced subset, which at
  // worst gives a coarse but correct outline rather than nothing at all.
  if (simplified.length > max) {
    const stride = simplified.length / max
    simplified = Array.from({ length: max }, (_, i) => simplified[Math.floor(i * stride)])
  }
  return simplified
}

/**
 * Finish a traced boundary into storable points: percentages, rounded,
 * de-duplicated, and refused when the result is degenerate.
 *
 * Shared by `magicSelect` and the mask reader so the two cannot disagree
 * about what the stored format will accept.
 */
export function boundaryToPoints(
  boundary: readonly [number, number][], width: number, height: number, maxPoints = MAX_POINTS,
): HotspotPoint[] | null {
  if (boundary.length < MIN_POINTS) return null
  const simplified = simplifyToLimit(boundary, maxPoints)
  if (simplified.length < MIN_POINTS) return null

  // Pixel centres, so a region touching an edge reaches 0 or 100 rather than
  // stopping half a pixel short.
  const points = simplified.map(([px, py]) => [
    roundPercent(clampPercent((px + 0.5) / width * 100)),
    roundPercent(clampPercent((py + 0.5) / height * 100)),
  ] as HotspotPoint)

  // Consecutive duplicates survive rounding on a small region and would make
  // the shape degenerate.
  const deduped = points.filter((p, i) => {
    const q = points[(i + points.length - 1) % points.length]
    return p[0] !== q[0] || p[1] !== q[1]
  })
  if (deduped.length < MIN_POINTS) return null
  if (polygonArea(deduped) <= MIN_AREA) return null
  return deduped
}

export interface MagicSelectOptions {
  /**
   * 0–100. How far a colour may drift from the seed and still count as the
   * same element. Low picks out a flat label; high swallows a gradient.
   */
  tolerance?: number
  maxPoints?: number
}

/**
 * Outline the element under (x, y), both given as percentages of the image.
 *
 * Returns points in the stored format — percentages, ≤ `maxPoints`, area
 * above the validator's floor — or `null` when the click did not land on
 * anything that reads as a distinct element. `null` is a real answer here:
 * reporting it lets the editor say "try a different spot" instead of
 * dropping a meaningless shape on the artwork.
 */
export function magicSelect(
  bmp: Bitmap, x: number, y: number, options: MagicSelectOptions = {},
): HotspotPoint[] | null {
  const { width, height } = bmp
  if (width < 2 || height < 2) return null

  const seedX = Math.max(0, Math.min(width - 1, Math.round(x / 100 * width)))
  const seedY = Math.max(0, Math.min(height - 1, Math.round(y / 100 * height)))

  // 12, not a looser default: artwork here is photographic, and anything
  // higher starts by swallowing the backdrop on the first click, which reads
  // as the feature being broken rather than as a setting to turn down.
  const tolerance = Math.max(0, Math.min(100, options.tolerance ?? 12))
  // Percent of the maximum RGB distance (255·√3), squared later.
  const threshold = tolerance / 100 * 441.67

  // Scaled with tolerance so one slider governs both: asking for a looser
  // colour match is also asking to push through softer edges. The top of the
  // range reaches ~1020, the Sobel magnitude of a full black-to-white step,
  // so maximum tolerance can cross any edge — otherwise the barrier would
  // put a ceiling on the slider that no setting could lift.
  const edgeLimit = 40 + tolerance * 14
  const { mask, filled } = floodMask(bmp, seedX, seedY, threshold, edgeLimit)
  const coverage = filled / (width * height)
  if (coverage < MIN_COVERAGE || coverage > MAX_COVERAGE) return null
  // Reaching all four sides is what the backdrop does, and a sharper test
  // than area alone: a backdrop that leaves a quarter of the frame to the
  // subject still passes a coverage cap, but it still touches every edge.
  // Something genuinely full-bleed is a box drag, not an element pick.
  if (touchesEveryEdge(mask, width, height)) return null

  const boundary = traceBoundary(mask, width, height)
  return boundaryToPoints(boundary, width, height, options.maxPoints ?? MAX_POINTS)
}
