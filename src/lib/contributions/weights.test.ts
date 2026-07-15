import { describe, it, expect } from 'vitest'
import { normalizeGroupWeights, formatGroupSplit } from './weights'

describe('normalizeGroupWeights', () => {
  it('normalizes any weight combination to percentages summing to 100', () => {
    const split = normalizeGroupWeights([
      { id: 'a', name: 'Design', weight: 50 },
      { id: 'b', name: 'Products', weight: 50 },
      { id: 'c', name: 'Marketing', weight: 50 },
    ])
    split.forEach(g => expect(g.pct).toBeCloseTo(100 / 3, 5))
    expect(split.reduce((s, g) => s + g.pct, 0)).toBeCloseTo(100, 5)
  })

  it('respects unequal ratios (50/25 → 66.7/33.3)', () => {
    const split = normalizeGroupWeights([
      { id: 'a', name: 'Design', weight: 50 },
      { id: 'b', name: 'Review', weight: 25 },
    ])
    expect(split[0].pct).toBeCloseTo(200 / 3, 5)
    expect(split[1].pct).toBeCloseTo(100 / 3, 5)
  })

  it('a single group gets 100%', () => {
    expect(normalizeGroupWeights([{ id: 'a', name: 'Design', weight: 7 }])[0].pct).toBe(100)
  })

  it('empty and all-zero inputs yield zero percentages, not NaN', () => {
    expect(normalizeGroupWeights([])).toEqual([])
    const zeros = normalizeGroupWeights([
      { id: 'a', name: 'A', weight: 0 },
      { id: 'b', name: 'B', weight: 0 },
    ])
    zeros.forEach(g => expect(g.pct).toBe(0))
  })

  it('matches the engine: same portions as commission.ts step 1 for active groups', () => {
    // 90 + 60 → 60% / 40%, mirroring groupActivePortion = weight/totalActiveWeight × 100
    const split = normalizeGroupWeights([
      { id: 'a', name: 'A', weight: 90 },
      { id: 'b', name: 'B', weight: 60 },
    ])
    expect(split[0].pct).toBeCloseTo(60, 5)
    expect(split[1].pct).toBeCloseTo(40, 5)
  })
})

describe('formatGroupSplit', () => {
  it('renders a compact label and strips the " Group" suffix', () => {
    expect(formatGroupSplit([
      { id: 'a', name: 'Flyer Design Group', weight: 50 },
      { id: 'b', name: 'Flyer Products Group', weight: 50 },
    ])).toBe('Flyer Design 50% · Flyer Products 50%')
  })

  it('shows one decimal for non-integer splits', () => {
    expect(formatGroupSplit([
      { id: 'a', name: 'A', weight: 50 },
      { id: 'b', name: 'B', weight: 50 },
      { id: 'c', name: 'C', weight: 50 },
    ])).toBe('A 33.3% · B 33.3% · C 33.3%')
  })
})
