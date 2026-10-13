import { describe, it, expect } from 'vitest'
import {
  createPaintMask, clearPaint, isPaintEmpty, stampBrush, strokeBrush, paintFromAlpha, PAINT_MAX,
} from './brush'
import { regionsFromMask } from './mask-regions'
import { validHotspots } from './hotspots'

const painted = (m: { data: Uint8Array }) => m.data.reduce((n, v) => n + v, 0)

describe('createPaintMask', () => {
  it('keeps the image’s aspect ratio', () => {
    const m = createPaintMask(1536, 2752)
    expect(Math.max(m.width, m.height)).toBe(PAINT_MAX)
    expect(m.width / m.height).toBeCloseTo(1536 / 2752, 2)
    expect(isPaintEmpty(m)).toBe(true)
  })

  it('never produces a degenerate mask', () => {
    for (const [w, h] of [[0, 0], [1, 1], [1, 5000]]) {
      const m = createPaintMask(w, h)
      expect(m.width).toBeGreaterThanOrEqual(2)
      expect(m.height).toBeGreaterThanOrEqual(2)
      expect(m.data.length).toBe(m.width * m.height)
    }
  })

  it('does not upscale a small image', () => {
    const m = createPaintMask(100, 50)
    expect(m.width).toBe(100)
  })
})

describe('stampBrush', () => {
  it('paints a round dab where it is told', () => {
    const m = createPaintMask(100, 100)
    stampBrush(m, 50, 50, 10)
    expect(m.data[50 * 100 + 50]).toBe(1)   // centre
    expect(m.data[50 * 100 + 95]).toBe(0)   // well outside
    expect(isPaintEmpty(m)).toBe(false)
  })

  it('erases what it passes over', () => {
    const m = createPaintMask(100, 100)
    stampBrush(m, 50, 50, 20)
    const before = painted(m)
    stampBrush(m, 50, 50, 10, true)
    expect(painted(m)).toBeLessThan(before)
    expect(m.data[50 * 100 + 50]).toBe(0)
  })

  it('stays round on a tall image rather than becoming an ellipse', () => {
    // The radius is a share of the SHORTER side, so the dab is as wide as it
    // is tall in pixels.
    const m = createPaintMask(100, 400)
    stampBrush(m, 50, 50, 10)
    let minX = m.width, maxX = -1, minY = m.height, maxY = -1
    for (let y = 0; y < m.height; y++) {
      for (let x = 0; x < m.width; x++) {
        if (m.data[y * m.width + x]) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x)
          minY = Math.min(minY, y); maxY = Math.max(maxY, y)
        }
      }
    }
    expect(Math.abs((maxX - minX) - (maxY - minY))).toBeLessThanOrEqual(1)
  })

  it('clips at the edges instead of reading past the buffer', () => {
    const m = createPaintMask(60, 60)
    expect(() => { stampBrush(m, 0, 0, 30); stampBrush(m, 100, 100, 30) }).not.toThrow()
    expect(m.data[0]).toBe(1)
    expect(m.data[m.data.length - 1]).toBe(1)
  })
})

describe('strokeBrush', () => {
  it('paints a continuous line, not dots', () => {
    // A fast drag reports points far apart; stamping only those leaves gaps
    // the tracer would read as separate shapes.
    const m = createPaintMask(200, 200)
    strokeBrush(m, [10, 50], [90, 50], 4)
    const { regions } = regionsFromMask(m.data, m.width, m.height)
    expect(regions).toHaveLength(1)
  })

  it('erases along a stroke too', () => {
    const m = createPaintMask(200, 200)
    strokeBrush(m, [10, 50], [90, 50], 6)
    const before = painted(m)
    strokeBrush(m, [10, 50], [90, 50], 6, true)
    expect(painted(m)).toBe(0)
    expect(before).toBeGreaterThan(0)
  })

  it('handles a stroke that does not move', () => {
    const m = createPaintMask(100, 100)
    expect(() => strokeBrush(m, [50, 50], [50, 50], 5)).not.toThrow()
    expect(isPaintEmpty(m)).toBe(false)
  })
})

describe('paint becomes areas', () => {
  it('traces two separate blobs as two storable areas', () => {
    const m = createPaintMask(200, 200)
    stampBrush(m, 25, 25, 12)
    stampBrush(m, 75, 75, 12)
    const { regions } = regionsFromMask(m.data, m.width, m.height)
    expect(regions).toHaveLength(2)
    expect(validHotspots({
      desktop: regions.map((points, i) => ({ id: `a${i}`, label: 'x', path: '/portfolio/social-media', points })),
      mobile: [],
    })).toBe(true)
  })

  it('finds nothing on a blank mask', () => {
    const m = createPaintMask(100, 100)
    expect(regionsFromMask(m.data, m.width, m.height).regions).toEqual([])
  })
})

describe('clearPaint', () => {
  it('empties without touching the original buffer', () => {
    const m = createPaintMask(50, 50)
    stampBrush(m, 50, 50, 20)
    const cleared = clearPaint(m)
    expect(isPaintEmpty(cleared)).toBe(true)
    expect(isPaintEmpty(m)).toBe(false)
  })
})

describe('paintFromAlpha', () => {
  it('turns a cut-out’s alpha into paint the brush can edit', () => {
    // 4×1: two opaque pixels, two transparent.
    const alpha = new Uint8ClampedArray([
      0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 10,
    ])
    const m = paintFromAlpha(alpha, 4, 1)
    expect(Array.from(m.data)).toEqual([1, 1, 0, 0])
  })
})
