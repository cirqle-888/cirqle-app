import { describe, it, expect } from 'vitest'
import { detectPlateColour, stripFlatBackgroundFromPixels } from './resize'

/** Build an RGBA buffer from a picture drawn with characters. */
function pixels(rows: string[], palette: Record<string, [number, number, number]>) {
  const height = rows.length
  const width = rows[0].length
  const data = new Uint8ClampedArray(width * height * 4)
  rows.forEach((row, y) => {
    ;[...row].forEach((ch, x) => {
      const [r, g, b] = palette[ch]
      const i = (y * width + x) * 4
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255
    })
  })
  return { data, width, height }
}

const alphaAt = (data: Uint8ClampedArray, width: number, x: number, y: number) =>
  data[(y * width + x) * 4 + 3]

const WHITE: [number, number, number] = [255, 255, 255]
const BLACK: [number, number, number] = [0, 0, 0]
const RED: [number, number, number] = [220, 30, 30]

describe('stripFlatBackgroundFromPixels', () => {
  it('erases a flat white background around a mark', () => {
    const { data, width, height } = pixels(
      [
        'wwwwww',
        'wwbbww',
        'wwbbww',
        'wwwwww',
      ],
      { w: WHITE, b: BLACK },
    )
    expect(stripFlatBackgroundFromPixels(data, width, height)).toBe(true)
    expect(alphaAt(data, width, 0, 0)).toBe(0)
    expect(alphaAt(data, width, 2, 1)).toBe(255) // the mark survives
  })

  it('keeps white ENCLOSED by the mark — a counter, not background', () => {
    const { data, width, height } = pixels(
      [
        'wwwwwww',
        'wbbbbbw',
        'wbwwwbw',
        'wbwwwbw',
        'wbbbbbw',
        'wwwwwww',
      ],
      { w: WHITE, b: BLACK },
    )
    expect(stripFlatBackgroundFromPixels(data, width, height)).toBe(true)
    expect(alphaAt(data, width, 0, 0)).toBe(0)   // outside is gone
    expect(alphaAt(data, width, 3, 2)).toBe(255) // the hole inside is kept
  })

  it('leaves artwork alone when the corners disagree', () => {
    const { data, width, height } = pixels(
      [
        'wwrr',
        'wwrr',
        'rrww',
        'rrww',
      ],
      { w: WHITE, r: RED },
    )
    expect(stripFlatBackgroundFromPixels(data, width, height)).toBe(false)
    expect(alphaAt(data, width, 0, 0)).toBe(255)
  })

  it('does nothing to a logo that is already transparent', () => {
    const { data, width, height } = pixels(['bb', 'bb'], { b: BLACK })
    for (let i = 3; i < data.length; i += 4) data[i] = 0
    expect(stripFlatBackgroundFromPixels(data, width, height)).toBe(false)
  })
})

describe('detectPlateColour', () => {
  it('finds the light slab a mark is drawn on', () => {
    // A small dark mark on a big white field: the field is the plate.
    const rows = [
      'wwwwwwww',
      'wwwwwwww',
      'wwwbbwww',
      'wwwbbwww',
      'wwwwwwww',
      'wwwwwwww',
    ]
    const { data, width, height } = pixels(rows, { w: WHITE, b: BLACK })
    expect(detectPlateColour(data, width, height)).toEqual([255, 255, 255])
  })

  it('finds a DARK slab too, when it runs to the edge', () => {
    // A light mark on a black rectangle: the rectangle is the backing.
    const rows = [
      'bbbbbbbb',
      'bbwwwwbb',
      'bbwbbwbb',
      'bbwwwwbb',
      'bbbbbbbb',
      'bbbbbbbb',
    ]
    const { data, width, height } = pixels(rows, { w: WHITE, b: BLACK })
    expect(detectPlateColour(data, width, height)).toEqual([0, 0, 0])
  })

  it('leaves a flat mark on transparency alone — erasing it would leave nothing', () => {
    const { data, width, height } = pixels(
      [
        'ttbbtt',
        'tbbbbt',
        'tbbbbt',
        'ttbbtt',
      ],
      { t: WHITE, b: BLACK },
    )
    // Make the 't' pixels actually transparent.
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === 255) data[i + 3] = 0
    }
    expect(detectPlateColour(data, width, height)).toBeNull()
  })

  it('leaves a dark mark floating on transparency alone — it never reaches the edge', () => {
    const { data, width, height } = pixels(
      [
        'tttttt',
        'trrbbt',
        'trrbbt',
        'tttttt',
      ],
      { t: WHITE, r: RED, b: BLACK },
    )
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === 255 && data[i + 1] === 255) data[i + 3] = 0
    }
    expect(detectPlateColour(data, width, height)).toBeNull()
  })

  it('leaves white LETTERING on transparency alone — strokes are not a slab', () => {
    const rows = [
      'tttttttt',
      'twttttwt',
      'twttttwt',
      'twwwwwwt',
      'twttttwt',
      'tttttttt',
    ]
    const { data, width, height } = pixels(rows, { w: WHITE, t: BLACK })
    // 't' is the transparent surround.
    for (let i = 0; i < data.length; i += 4) if (data[i] === 0) data[i + 3] = 0
    expect(detectPlateColour(data, width, height)).toBeNull()
  })

  it('treats a dark field behind light lettering AS a plate — it reaches the edge', () => {
    const rows = [
      'bbbbbbbb',
      'bwbbbbwb',
      'bwbbbbwb',
      'bwwwwwwb',
      'bwbbbbwb',
      'bbbbbbbb',
    ]
    const { data, width, height } = pixels(rows, { w: WHITE, b: BLACK })
    expect(detectPlateColour(data, width, height)).toEqual([0, 0, 0])
  })

  it('ignores transparent pixels when judging the share', () => {
    const { data, width, height } = pixels(['ww', 'ww'], { w: WHITE })
    for (let i = 3; i < data.length; i += 4) data[i] = 0
    expect(detectPlateColour(data, width, height)).toBeNull()
  })
})
