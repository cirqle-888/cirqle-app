import { describe, it, expect } from 'vitest'
import { computeEqualSplit, splitsReconcile } from './splits'

describe('computeEqualSplit', () => {
  it('splits evenly when it divides cleanly', () => {
    const shares = computeEqualSplit(1000, ['a', 'b'])
    expect(shares).toEqual([{ employeeId: 'a', amount: 500 }, { employeeId: 'b', amount: 500 }])
  })

  it('distributes the rounding remainder to the first employees, in order', () => {
    // 100 / 3 = 33.333... -> 33.34, 33.33, 33.33 (extra paisa to the first)
    const shares = computeEqualSplit(100, ['a', 'b', 'c'])
    expect(shares).toEqual([
      { employeeId: 'a', amount: 33.34 },
      { employeeId: 'b', amount: 33.33 },
      { employeeId: 'c', amount: 33.33 },
    ])
    expect(splitsReconcile(shares, 100)).toBe(true)
  })

  it('always sums exactly to the total for a range of awkward divisions', () => {
    for (const [total, n] of [[100, 3], [7.99, 3], [1000, 7], [0.03, 2], [999.98, 4]] as const) {
      const ids = Array.from({ length: n }, (_, i) => `emp${i}`)
      const shares = computeEqualSplit(total, ids)
      expect(splitsReconcile(shares, total)).toBe(true)
    }
  })

  it('single employee gets the whole amount', () => {
    expect(computeEqualSplit(500, ['solo'])).toEqual([{ employeeId: 'solo', amount: 500 }])
  })

  it('dedupes repeated employee ids', () => {
    const shares = computeEqualSplit(1000, ['a', 'a', 'b'])
    expect(shares).toHaveLength(2)
    expect(splitsReconcile(shares, 1000)).toBe(true)
  })

  it('returns empty for no employees or non-positive total', () => {
    expect(computeEqualSplit(1000, [])).toEqual([])
    expect(computeEqualSplit(0, ['a'])).toEqual([])
    expect(computeEqualSplit(-50, ['a'])).toEqual([])
  })

  it('ignores falsy employee ids mixed into the list', () => {
    const shares = computeEqualSplit(1000, ['a', '', 'b'] as string[])
    expect(shares.map(s => s.employeeId)).toEqual(['a', 'b'])
  })
})

describe('splitsReconcile', () => {
  it('tolerates sub-paisa float noise', () => {
    expect(splitsReconcile([{ employeeId: 'a', amount: 33.34 }, { employeeId: 'b', amount: 33.33 }, { employeeId: 'c', amount: 33.33 }], 100)).toBe(true)
  })
  it('rejects a real mismatch', () => {
    expect(splitsReconcile([{ employeeId: 'a', amount: 10 }], 20)).toBe(false)
  })
})
