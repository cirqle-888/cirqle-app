import { describe, it, expect } from 'vitest'
import {
  magicSelect, rectangleFromDrag, movePolygon, movePoint, polygonArea, simplifyToLimit,
  type Bitmap,
} from './trace'
import { validHotspots, type HotspotPoint } from './hotspots'

/** A canvas of one colour, for painting shapes onto. */
function canvas(width: number, height: number, rgb: [number, number, number]): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255
  }
  return { data, width, height }
}

function fillRect(
  bmp: Bitmap, x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number],
) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * bmp.width + x) * 4
      bmp.data[i] = rgb[0]; bmp.data[i + 1] = rgb[1]; bmp.data[i + 2] = rgb[2]; bmp.data[i + 3] = 255
    }
  }
}

/** Anything this module returns must be storable — that is the whole contract. */
const storable = (points: HotspotPoint[] | null) => {
  expect(points).not.toBeNull()
  return validHotspots({
    desktop: [{ id: 'a', label: 'x', path: '/portfolio/social-media', points: points! }],
    mobile: [],
  })
}

const bounds = (points: HotspotPoint[]) => ({
  left: Math.min(...points.map(p => p[0])),
  right: Math.max(...points.map(p => p[0])),
  top: Math.min(...points.map(p => p[1])),
  bottom: Math.max(...points.map(p => p[1])),
})

describe('magicSelect', () => {
  it('outlines a poster sitting on a contrasting backdrop', () => {
    // A dark backdrop with one pale poster from 20%–60% across and down.
    const bmp = canvas(100, 100, [20, 10, 30])
    fillRect(bmp, 20, 20, 60, 60, [240, 230, 220])

    const points = magicSelect(bmp, 40, 40)
    expect(storable(points)).toBe(true)

    // Within a pixel of the real edges (1 pixel = 1% on a 100px canvas).
    const b = bounds(points!)
    expect(b.left).toBeGreaterThanOrEqual(19)
    expect(b.left).toBeLessThanOrEqual(21.5)
    expect(b.right).toBeGreaterThanOrEqual(58.5)
    expect(b.right).toBeLessThanOrEqual(61)
    expect(b.top).toBeGreaterThanOrEqual(19)
    expect(b.bottom).toBeLessThanOrEqual(61)
  })

  it('picks the element under the click, not its neighbour', () => {
    const bmp = canvas(100, 100, [0, 0, 0])
    fillRect(bmp, 5, 5, 35, 35, [255, 0, 0])    // left bag
    fillRect(bmp, 65, 65, 95, 95, [0, 0, 255])  // right bag

    const left = bounds(magicSelect(bmp, 20, 20)!)
    expect(left.right).toBeLessThan(40)

    const right = bounds(magicSelect(bmp, 80, 80)!)
    expect(right.left).toBeGreaterThan(60)
  })

  it('never returns more points than the format stores', () => {
    // A ragged circle: hundreds of boundary pixels, none of them collinear.
    const bmp = canvas(120, 120, [0, 0, 0])
    for (let y = 0; y < 120; y++) {
      for (let x = 0; x < 120; x++) {
        if (Math.hypot(x - 60, y - 60) < 40) fillRect(bmp, x, y, x + 1, y + 1, [255, 255, 255])
      }
    }
    const points = magicSelect(bmp, 50, 50)
    expect(points!.length).toBeLessThanOrEqual(16)
    expect(points!.length).toBeGreaterThanOrEqual(3)
    expect(storable(points)).toBe(true)
  })

  it('honours a smaller point budget', () => {
    const bmp = canvas(100, 100, [0, 0, 0])
    fillRect(bmp, 10, 10, 90, 90, [255, 255, 255])
    expect(magicSelect(bmp, 50, 50, { maxPoints: 6 })!.length).toBeLessThanOrEqual(6)
  })

  it('declines the backdrop rather than selecting the whole image', () => {
    // Clicking the background grows to nearly everything — not an element.
    const bmp = canvas(100, 100, [20, 10, 30])
    fillRect(bmp, 45, 45, 55, 55, [240, 230, 220])
    expect(magicSelect(bmp, 2, 2)).toBeNull()
  })

  it('declines a speck', () => {
    const bmp = canvas(200, 200, [0, 0, 0])
    fillRect(bmp, 100, 100, 102, 102, [255, 255, 255]) // 4px of 40,000
    expect(magicSelect(bmp, 50, 50)).toBeNull()
  })

  it('declines a flat image, where everything is one region', () => {
    expect(magicSelect(canvas(60, 60, [128, 128, 128]), 50, 50)).toBeNull()
  })

  it('declines a backdrop that reaches every edge, even below the area cap', () => {
    // The case that got through on the real artwork: a backdrop wrapping a
    // subject still leaves a third of the frame, so an area cap alone passes
    // it — but it touches all four sides, which an element does not.
    const bmp = canvas(100, 100, [18, 10, 28])
    fillRect(bmp, 30, 25, 75, 85, [240, 230, 220])
    const picked = magicSelect(bmp, 2, 50)
    expect(picked).toBeNull()
  })

  it('still outlines a large element that does not wrap the frame', () => {
    const bmp = canvas(100, 100, [18, 10, 28])
    fillRect(bmp, 5, 5, 72, 95, [240, 230, 220])
    expect(storable(magicSelect(bmp, 40, 50))).toBe(true)
  })

  it('tolerance decides whether a shaded edge joins the element', () => {
    // A white poster with a grey border: low tolerance takes the core only,
    // high tolerance takes both.
    const bmp = canvas(100, 100, [0, 0, 0])
    fillRect(bmp, 20, 20, 80, 80, [150, 150, 150])
    fillRect(bmp, 30, 30, 70, 70, [255, 255, 255])

    const tight = bounds(magicSelect(bmp, 50, 50, { tolerance: 5 })!)
    const loose = bounds(magicSelect(bmp, 50, 50, { tolerance: 70 })!)
    expect(tight.left).toBeGreaterThan(loose.left)
    expect(tight.right).toBeLessThan(loose.right)
  })

  it('handles an element running off the edge of the artwork', () => {
    const bmp = canvas(100, 100, [10, 10, 10])
    fillRect(bmp, 0, 0, 40, 40, [255, 255, 255])
    const points = magicSelect(bmp, 10, 10)
    expect(storable(points)).toBe(true)
    expect(Math.min(...points!.map(p => p[0]))).toBeLessThan(2)
  })

  it('clamps a click outside the image instead of reading past the buffer', () => {
    const bmp = canvas(50, 50, [0, 0, 0])
    fillRect(bmp, 0, 0, 20, 20, [255, 255, 255])
    expect(() => magicSelect(bmp, -40, 400)).not.toThrow()
  })

  it('refuses an image too small to outline anything', () => {
    expect(magicSelect(canvas(1, 1, [0, 0, 0]), 50, 50)).toBeNull()
  })
})

describe('rectangleFromDrag', () => {
  it('normalises a drag in any direction', () => {
    const downRight = rectangleFromDrag(10, 20, 60, 70)
    const upLeft = rectangleFromDrag(60, 70, 10, 20)
    expect(upLeft).toEqual(downRight)
    expect(downRight).toEqual([[10, 20], [60, 20], [60, 70], [10, 70]])
  })

  it('turns a near-click into a usable box rather than a rejected sliver', () => {
    const points = rectangleFromDrag(50, 50, 50.2, 50.1)
    expect(polygonArea(points)).toBeGreaterThan(2)
    expect(storable(points)).toBe(true)
  })

  it('keeps a grown box inside the image when the drag ends at the corner', () => {
    const points = rectangleFromDrag(100, 100, 100, 100)
    expect(bounds(points).right).toBeLessThanOrEqual(100)
    expect(bounds(points).bottom).toBeLessThanOrEqual(100)
    expect(storable(points)).toBe(true)
  })

  it('clamps a drag that leaves the image', () => {
    const b = bounds(rectangleFromDrag(-30, -30, 130, 130))
    expect(b.left).toBe(0)
    expect(b.top).toBe(0)
    expect(b.right).toBe(100)
    expect(b.bottom).toBe(100)
  })
})

describe('movePolygon', () => {
  const square: HotspotPoint[] = [[10, 10], [30, 10], [30, 30], [10, 30]]

  it('moves the shape as one', () => {
    expect(movePolygon(square, 5, -5)).toEqual([[15, 5], [35, 5], [35, 25], [15, 25]])
  })

  it('stops at the edge without deforming', () => {
    // Clamping each point separately would flatten the square against the edge.
    const moved = movePolygon(square, 999, 0)
    expect(bounds(moved).right).toBe(100)
    expect(bounds(moved).right - bounds(moved).left).toBe(20)
  })

  it('stops at the near edge too', () => {
    const moved = movePolygon(square, -999, -999)
    expect(bounds(moved)).toMatchObject({ left: 0, top: 0 })
    expect(bounds(moved).right).toBe(20)
  })
})

describe('movePoint', () => {
  const square: HotspotPoint[] = [[10, 10], [30, 10], [30, 30], [10, 30]]

  it('moves one vertex and leaves the rest alone', () => {
    expect(movePoint(square, 1, 40, 5)).toEqual([[10, 10], [40, 5], [30, 30], [10, 30]])
  })

  it('clamps to the image', () => {
    expect(movePoint(square, 0, -20, 150)).toEqual([[0, 100], [30, 10], [30, 30], [10, 30]])
  })
})

describe('simplifyToLimit', () => {
  it('leaves a shape that already fits untouched', () => {
    const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]]
    expect(simplifyToLimit(square)).toEqual(square)
  })

  it('keeps the corners of a rectangle it has to simplify', () => {
    // A dense trace of a rectangle's edge: every corner must survive.
    const dense: [number, number][] = []
    for (let x = 0; x <= 100; x++) dense.push([x, 0])
    for (let y = 1; y <= 50; y++) dense.push([100, y])
    for (let x = 99; x >= 0; x--) dense.push([x, 50])
    for (let y = 49; y >= 1; y--) dense.push([0, y])

    const simplified = simplifyToLimit(dense)
    expect(simplified.length).toBeLessThanOrEqual(16)
    for (const corner of [[0, 0], [100, 0], [100, 50], [0, 50]]) {
      expect(simplified.some(p => p[0] === corner[0] && p[1] === corner[1])).toBe(true)
    }
  })

  it('always reaches the limit, even on a shape with no straight edges', () => {
    const circle: [number, number][] = Array.from({ length: 500 }, (_, i) => {
      const t = (i / 500) * Math.PI * 2
      return [50 + Math.cos(t) * 40, 50 + Math.sin(t) * 40] as [number, number]
    })
    expect(simplifyToLimit(circle).length).toBeLessThanOrEqual(16)
  })
})

describe('polygonArea', () => {
  it('measures a square', () => {
    expect(polygonArea([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(100)
  })

  it('ignores winding direction', () => {
    expect(polygonArea([[0, 0], [0, 10], [10, 10], [10, 0]])).toBe(100)
  })

  it('is zero for a degenerate shape', () => {
    expect(polygonArea([[5, 5], [5, 5], [5, 5]])).toBe(0)
  })
})
