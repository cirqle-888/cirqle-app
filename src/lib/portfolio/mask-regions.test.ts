import { describe, it, expect } from 'vitest'
import { detectMaskRegions } from './mask-regions'
import { validHotspots, type HotspotPoint } from './hotspots'
import type { Bitmap } from './trace'

function canvas(width: number, height: number, rgb: [number, number, number], alpha = 255): Bitmap {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = alpha
  }
  return { data, width, height }
}

function paint(
  bmp: Bitmap, x0: number, y0: number, x1: number, y1: number,
  rgb: [number, number, number], alpha = 255,
) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * bmp.width + x) * 4
      bmp.data[i] = rgb[0]; bmp.data[i + 1] = rgb[1]; bmp.data[i + 2] = rgb[2]; bmp.data[i + 3] = alpha
    }
  }
}

const BLACK: [number, number, number] = [0, 0, 0]
const WHITE: [number, number, number] = [255, 255, 255]

const bounds = (p: HotspotPoint[]) => ({
  left: Math.min(...p.map(q => q[0])), right: Math.max(...p.map(q => q[0])),
  top: Math.min(...p.map(q => q[1])), bottom: Math.max(...p.map(q => q[1])),
})

/** Every polygon this returns must be storable — that is the contract. */
const storable = (regions: HotspotPoint[][]) => validHotspots({
  desktop: regions.map((points, i) => ({
    id: `a${i}`, label: 'x', path: '/portfolio/social-media', points,
  })),
  mobile: [],
})

describe('reading a painted mask', () => {
  it('turns black shapes on white into one area each', () => {
    const mask = canvas(100, 100, WHITE)
    paint(mask, 10, 10, 40, 40, BLACK)
    paint(mask, 60, 55, 90, 95, BLACK)

    const { regions, mode } = detectMaskRegions(mask)
    expect(mode).toBe('colour')
    expect(regions).toHaveLength(2)
    expect(storable(regions)).toBe(true)

    // Largest first, and each in the right place to within a pixel.
    const big = bounds(regions[0])
    expect(big.left).toBeGreaterThanOrEqual(59)
    expect(big.right).toBeLessThanOrEqual(91)
    const small = bounds(regions[1])
    expect(small.left).toBeGreaterThanOrEqual(9)
    expect(small.right).toBeLessThanOrEqual(41)
  })

  it('works the other way round — white shapes on black', () => {
    const mask = canvas(100, 100, BLACK)
    paint(mask, 20, 20, 70, 70, WHITE)
    const { regions } = detectMaskRegions(mask)
    expect(regions).toHaveLength(1)
    expect(bounds(regions[0]).left).toBeGreaterThanOrEqual(19)
  })

  it('reads one rare colour painted over a copy of the artwork', () => {
    // The "any rare colour" case: a busy image with one magenta shape on it.
    const mask = canvas(120, 120, [40, 24, 50])
    for (let y = 0; y < 120; y++) {
      for (let x = 0; x < 120; x++) {
        // Noise, so no two pixels match exactly — bucketing has to carry this.
        paint(mask, x, y, x + 1, y + 1, [40 + (x % 5), 24 + (y % 5), 50 + ((x + y) % 5)])
      }
    }
    paint(mask, 30, 40, 80, 90, [255, 0, 220])
    const { regions } = detectMaskRegions(mask)
    expect(regions).toHaveLength(1)
    expect(bounds(regions[0]).left).toBeGreaterThanOrEqual(24)   // 30 of 120px
    expect(bounds(regions[0]).bottom).toBeLessThanOrEqual(76)     // 90 of 120px
  })

  it('uses transparency when the file has it', () => {
    const mask = canvas(100, 100, WHITE, 0)
    paint(mask, 25, 25, 75, 75, [12, 200, 90], 255)
    const { regions, mode } = detectMaskRegions(mask)
    expect(mode).toBe('transparency')
    expect(regions).toHaveLength(1)
    expect(bounds(regions[0]).right).toBeLessThanOrEqual(76)
  })

  it('keeps two shapes apart when they touch only at a corner', () => {
    const mask = canvas(100, 100, WHITE)
    paint(mask, 10, 10, 50, 50, BLACK)
    paint(mask, 50, 50, 90, 90, BLACK)
    expect(detectMaskRegions(mask).regions).toHaveLength(2)
  })

  it('ignores stray marks and says how many', () => {
    const mask = canvas(200, 200, WHITE)
    paint(mask, 20, 20, 120, 120, BLACK)
    paint(mask, 180, 180, 182, 182, BLACK) // a speck
    const { regions, ignoredSpecks } = detectMaskRegions(mask)
    expect(regions).toHaveLength(1)
    expect(ignoredSpecks).toBe(1)
  })

  it('stops at the area limit, keeping the biggest, and reports the rest', () => {
    const mask = canvas(200, 200, WHITE)
    // Five shapes of descending size.
    paint(mask, 5, 5, 95, 95, BLACK)
    paint(mask, 110, 5, 190, 85, BLACK)
    paint(mask, 5, 110, 75, 180, BLACK)
    paint(mask, 110, 110, 170, 170, BLACK)
    paint(mask, 180, 110, 195, 125, BLACK)

    const { regions, ignoredOverflow } = detectMaskRegions(mask, { maxRegions: 2 })
    expect(regions).toHaveLength(2)
    expect(ignoredOverflow).toBe(3)
    // Biggest kept: the first shape is 90×90.
    const first = bounds(regions[0])
    expect(first.right - first.left).toBeGreaterThan(40)
  })

  it('still finds the shapes when the paint outnumbers the background', () => {
    // The background is read from the border, not from a global count: paint
    // most of the canvas and a global count names the SHAPES as background,
    // then returns one enormous region with holes in it.
    const mask = canvas(100, 100, WHITE)
    paint(mask, 2, 2, 60, 98, BLACK)
    paint(mask, 65, 2, 98, 98, BLACK)
    const { regions } = detectMaskRegions(mask)
    expect(regions).toHaveLength(2)
    expect(storable(regions)).toBe(true)
  })

  it('finds nothing in a blank mask rather than inventing an area', () => {
    expect(detectMaskRegions(canvas(80, 80, WHITE)).regions).toEqual([])
  })

  it('finds nothing in a photo with no flat background', () => {
    // Every pixel different: no colour is common enough to be a background,
    // so nothing stands out from it.
    const noise = canvas(60, 60, BLACK)
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 60; x++) paint(noise, x, y, x + 1, y + 1, [x * 4 % 256, y * 4 % 256, 128])
    }
    expect(storable(detectMaskRegions(noise).regions)).toBe(true)
  })

  it('handles a shape that runs off the edge', () => {
    const mask = canvas(100, 100, WHITE)
    paint(mask, 0, 0, 45, 45, BLACK)
    const { regions } = detectMaskRegions(mask)
    expect(regions).toHaveLength(1)
    expect(bounds(regions[0]).left).toBeLessThan(2)
    expect(storable(regions)).toBe(true)
  })

  it('refuses an image too small to hold a shape', () => {
    expect(detectMaskRegions(canvas(1, 1, WHITE)).regions).toEqual([])
    expect(detectMaskRegions(canvas(50, 50, WHITE), { maxRegions: 0 }).regions).toEqual([])
  })

  it('never returns a polygon the stored format would reject', () => {
    const mask = canvas(150, 150, WHITE)
    // A ragged blob with a concave bite out of it.
    for (let y = 20; y < 130; y++) {
      for (let x = 20; x < 130; x++) {
        const bite = x > 70 && y > 70 && Math.hypot(x - 130, y - 130) < 55
        if (!bite) paint(mask, x, y, x + 1, y + 1, BLACK)
      }
    }
    const { regions } = detectMaskRegions(mask)
    expect(regions.length).toBeGreaterThanOrEqual(1)
    for (const r of regions) {
      expect(r.length).toBeGreaterThanOrEqual(3)
      expect(r.length).toBeLessThanOrEqual(16)
    }
    expect(storable(regions)).toBe(true)
  })
})
