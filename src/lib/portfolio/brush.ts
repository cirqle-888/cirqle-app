/**
 * Painting a selection by hand.
 *
 * The automatic tools each fail somewhere: colour-region growing cannot tell a
 * bag from the curtain behind it, and background removal finds the subject but
 * not "the left half of the poster". A brush has no such limit — it does
 * exactly what it is told, which is the right last resort, and the right FIRST
 * resort for a shape nothing else can describe.
 *
 * The mask is a plain Uint8Array of 0/1 at a working resolution, traced into
 * polygons by `regionsFromMask` — the same function an uploaded mask goes
 * through, so painting and uploading cannot disagree about what a shape is.
 *
 * Pure and dependency-free: no canvas, no DOM. Coordinates are percentages of
 * the image, like everything else in this feature, so a brush stroke means the
 * same thing at any zoom and on any screen.
 */

export interface PaintMask {
  data: Uint8Array
  width: number
  height: number
}

/**
 * Working resolution for a painted mask.
 *
 * The same cap the rest of the feature samples at. A polygon is simplified to
 * at most sixteen points, so detail beyond this is thrown away moments later;
 * paying for it would only make every stroke slower.
 */
export const PAINT_MAX = 640

/** A blank mask sized to an image's aspect ratio, capped at PAINT_MAX. */
export function createPaintMask(imageWidth: number, imageHeight: number): PaintMask {
  const scale = Math.min(1, PAINT_MAX / Math.max(imageWidth || 1, imageHeight || 1))
  const width = Math.max(2, Math.round((imageWidth || 1) * scale))
  const height = Math.max(2, Math.round((imageHeight || 1) * scale))
  return { data: new Uint8Array(width * height), width, height }
}

/** Is anything painted? Drives whether "make areas from paint" is offered. */
export function isPaintEmpty(mask: PaintMask): boolean {
  return !mask.data.some(v => v === 1)
}

export function clearPaint(mask: PaintMask): PaintMask {
  return { ...mask, data: new Uint8Array(mask.data.length) }
}

/**
 * Stamp one round dab, centred on a point given in image percentages.
 *
 * Mutates `mask.data` — a stroke stamps hundreds of times and copying the
 * buffer for each one is the difference between a brush that keeps up with the
 * pointer and one that does not. Callers that need undo snapshot between
 * STROKES, not between dabs.
 */
export function stampBrush(
  mask: PaintMask, x: number, y: number, radiusPercent: number, erase = false,
): void {
  const { data, width, height } = mask
  const cx = x / 100 * width
  const cy = y / 100 * height
  // The radius is a percentage of the image's SHORTER side, so a brush stays
  // round on a tall artwork instead of becoming an ellipse.
  const r = Math.max(0.5, radiusPercent / 100 * Math.min(width, height))
  const r2 = r * r
  const value = erase ? 0 : 1

  const left = Math.max(0, Math.floor(cx - r))
  const right = Math.min(width - 1, Math.ceil(cx + r))
  const top = Math.max(0, Math.floor(cy - r))
  const bottom = Math.min(height - 1, Math.ceil(cy + r))

  for (let py = top; py <= bottom; py++) {
    const dy = py + 0.5 - cy
    for (let px = left; px <= right; px++) {
      const dx = px + 0.5 - cx
      if (dx * dx + dy * dy <= r2) data[py * width + px] = value
    }
  }
}

/**
 * Stamp along a segment, so a fast drag paints a line rather than dots.
 *
 * A pointer moving quickly fires events tens of pixels apart; stamping only at
 * the reported points leaves a dotted trail with gaps the tracer then reads as
 * separate shapes.
 */
export function strokeBrush(
  mask: PaintMask,
  from: readonly [number, number],
  to: readonly [number, number],
  radiusPercent: number,
  erase = false,
): void {
  const r = Math.max(0.5, radiusPercent / 100 * Math.min(mask.width, mask.height))
  // Step in mask pixels, at a fraction of the radius so dabs overlap.
  const dxPx = (to[0] - from[0]) / 100 * mask.width
  const dyPx = (to[1] - from[1]) / 100 * mask.height
  const distance = Math.hypot(dxPx, dyPx)
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, r * 0.4)))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    stampBrush(mask, from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, radiusPercent, erase)
  }
}

/**
 * Seed a mask from an alpha channel — what background removal hands back.
 *
 * Lets "remove the background" become "outline the subject, then fix it with
 * the brush": the model's alpha becomes paint the user can add to and rub out,
 * rather than a result they must accept or discard whole.
 */
export function paintFromAlpha(
  alpha: Uint8ClampedArray, width: number, height: number, threshold = 128,
): PaintMask {
  const data = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) data[i] = alpha[i * 4 + 3] >= threshold ? 1 : 0
  return { data, width, height }
}
