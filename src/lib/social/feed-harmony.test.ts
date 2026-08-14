import { describe, it, expect } from 'vitest'
import {
  analyseHarmony, brightnessOf, colorDistance, neighbourPairs, distancePct,
} from './feed-harmony'
import type { TileColor } from './feed-harmony'

const c = (key: string, r: number, g: number, b: number): TileColor => ({ key, r, g, b })

/** n tiles of near-identical muted colour. */
const cohesive = (n: number) =>
  Array.from({ length: n }, (_, i) => c(`t${i}`, 120 + (i % 3), 118, 115))

describe('colour basics', () => {
  it('weights green most in perceived brightness, as the eye does', () => {
    expect(brightnessOf(c('g', 0, 255, 0))).toBeGreaterThan(brightnessOf(c('r', 255, 0, 0)))
    expect(brightnessOf(c('r', 255, 0, 0))).toBeGreaterThan(brightnessOf(c('b', 0, 0, 255)))
  })

  it('measures distance symmetrically, and zero against itself', () => {
    const a = c('a', 10, 20, 30), b = c('b', 200, 100, 50)
    expect(colorDistance(a, a)).toBe(0)
    expect(colorDistance(a, b)).toBeCloseTo(colorDistance(b, a))
  })

  it('reports black-to-white as 100% apart', () => {
    expect(distancePct(c('k', 0, 0, 0), c('w', 255, 255, 255))).toBe(100)
  })
})

describe('neighbours in a 3-column grid', () => {
  it('pairs each tile with the one to its right and the one below', () => {
    // 0 1 2
    // 3 4 5
    const pairs = neighbourPairs(6)
    expect(pairs).toContainEqual([0, 1])
    expect(pairs).toContainEqual([1, 2])
    expect(pairs).toContainEqual([0, 3])
  })

  it('does not wrap across a row edge — 2 and 3 are not neighbours', () => {
    // They are visually diagonal, and a finding about them would confuse.
    expect(neighbourPairs(6)).not.toContainEqual([2, 3])
  })

  it('excludes diagonals', () => {
    expect(neighbourPairs(6)).not.toContainEqual([0, 4])
  })

  it('handles a partial last row without inventing tiles', () => {
    const pairs = neighbourPairs(4)
    expect(pairs.every(([a, b]) => a < 4 && b < 4)).toBe(true)
  })
})

describe('what the analyser reports', () => {
  it('says nothing at all below three tiles — too little to judge', () => {
    const r = analyseHarmony({ colors: [c('a', 0, 0, 0), c('b', 255, 255, 255)] })
    expect(r.findings).toEqual([])
    expect(r.score).toBe(100)
  })

  it('leaves a cohesive grid alone', () => {
    // The most important negative case: a good feed must produce no nagging.
    const r = analyseHarmony({ colors: cohesive(9) })
    expect(r.findings.filter(f => f.kind === 'clash')).toEqual([])
    expect(r.score).toBeGreaterThanOrEqual(90)
  })

  it('flags two loud neighbours', () => {
    const colors = [...cohesive(9)]
    colors[1] = c('t1', 255, 20, 20)     // beside t0 and above t4
    const r = analyseHarmony({ colors })
    const clash = r.findings.find(f => f.kind === 'clash')
    expect(clash).toBeTruthy()
    expect(clash!.keys).toContain('t1')
  })

  it('notices a feed with no variation at all', () => {
    const flat = Array.from({ length: 9 }, (_, i) => c(`t${i}`, 128, 128, 128))
    expect(analyseHarmony({ colors: flat }).findings.some(f => f.kind === 'monotony')).toBe(true)
  })

  it('flags a patchy dark/light swing and names both ends', () => {
    const colors = [...cohesive(9)]
    colors[0] = c('t0', 5, 5, 5)
    colors[8] = c('t8', 250, 250, 250)
    const f = analyseHarmony({ colors }).findings.find(x => x.kind === 'brightness_swing')
    expect(f).toBeTruthy()
    expect(f!.keys).toEqual(expect.arrayContaining(['t0', 't8']))
    expect(f!.severity).toBe('warn')
  })

  it('flags posts far from the brand palette, and only those', () => {
    const palette = [c('brand', 120, 118, 115)]
    const colors = [...cohesive(9)]
    colors[4] = c('t4', 255, 0, 255)
    const f = analyseHarmony({ colors, palette }).findings.find(x => x.kind === 'off_palette')
    expect(f).toBeTruthy()
    expect(f!.keys).toEqual(['t4'])
  })

  it('says nothing about palette when none is configured', () => {
    const colors = [...cohesive(9)]
    colors[4] = c('t4', 255, 0, 255)
    expect(analyseHarmony({ colors }).findings.some(f => f.kind === 'off_palette')).toBe(false)
  })

  it('caps clash findings so a chaotic grid does not produce a wall of text', () => {
    const chaos = Array.from({ length: 9 }, (_, i) =>
      c(`t${i}`, i % 2 ? 255 : 0, i % 3 ? 255 : 0, i % 2 ? 0 : 255))
    expect(analyseHarmony({ colors: chaos }).findings.filter(f => f.kind === 'clash').length)
      .toBeLessThanOrEqual(4)
  })

  it('keeps the score inside 0-100 however bad the grid is', () => {
    const chaos = Array.from({ length: 12 }, (_, i) =>
      c(`t${i}`, i % 2 ? 255 : 0, i % 3 ? 255 : 0, i % 2 ? 0 : 255))
    const r = analyseHarmony({ colors: chaos, palette: [c('p', 10, 10, 10)] })
    expect(r.score).toBeGreaterThanOrEqual(0)
    expect(r.score).toBeLessThanOrEqual(100)
  })

  it('reports average brightness so "is this feed dark?" is answerable', () => {
    expect(analyseHarmony({ colors: Array.from({ length: 5 }, (_, i) => c(`t${i}`, 0, 0, 0)) }).averageBrightness)
      .toBe(0)
    expect(analyseHarmony({ colors: Array.from({ length: 5 }, (_, i) => c(`t${i}`, 255, 255, 255)) }).averageBrightness)
      .toBe(255)
  })

  it('is deterministic — the same grid always gives the same verdict', () => {
    const colors = cohesive(9)
    expect(analyseHarmony({ colors })).toEqual(analyseHarmony({ colors }))
  })
})
