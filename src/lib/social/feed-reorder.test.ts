import { describe, it, expect } from 'vitest'
import {
  minimalMoves, applyMoves, longestIncreasingSubsequence, gridPosition,
  pinChanges, effectiveTarget, isInSync, MAX_PINNED,
} from './feed-reorder'

const grid = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`)

describe('longestIncreasingSubsequence', () => {
  it('finds the longest run that is already in order', () => {
    expect(longestIncreasingSubsequence([0, 1, 2, 3])).toEqual([0, 1, 2, 3])
  })

  it('handles a fully reversed sequence — only one can stay', () => {
    expect(longestIncreasingSubsequence([3, 2, 1, 0])).toHaveLength(1)
  })

  it('picks a genuinely longest chain, not a greedy one', () => {
    // 10,9,2,5,3,7,101,18 → longest is 2,5,7,101 (or 2,3,7,101): length 4.
    expect(longestIncreasingSubsequence([10, 9, 2, 5, 3, 7, 101, 18])).toHaveLength(4)
  })

  it('is empty for an empty input', () => {
    expect(longestIncreasingSubsequence([])).toEqual([])
  })

  it('returns indices, in increasing order', () => {
    const idx = longestIncreasingSubsequence([5, 1, 6, 2, 7])
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
  })
})

describe('minimalMoves', () => {
  it('asks for nothing when the grid is already right', () => {
    const g = grid(9)
    expect(minimalMoves(g, g)).toEqual([])
  })

  it('moves one post to the front in a single step', () => {
    const moves = minimalMoves(['a', 'b', 'c'], ['c', 'a', 'b'])
    expect(moves).toHaveLength(1)
    expect(moves[0]).toEqual({ key: 'c', toIndex: 0, afterKey: null })
  })

  it('is minimal: n − |LIS|, never a move per tile', () => {
    // Only 'e' is out of place, so one move — not five.
    const current = ['a', 'b', 'c', 'd', 'e']
    const target  = ['e', 'a', 'b', 'c', 'd']
    expect(minimalMoves(current, target)).toHaveLength(1)
  })

  it('needs n−1 moves for a full reversal, which really is minimal', () => {
    const current = ['a', 'b', 'c', 'd']
    const target  = ['d', 'c', 'b', 'a']
    expect(minimalMoves(current, target)).toHaveLength(3)
  })

  it('produces instructions that are correct AS PERFORMED', () => {
    // The whole point: each toIndex is relative to the grid at that moment,
    // so following them in order actually lands on the target.
    const current = ['a', 'b', 'c', 'd', 'e', 'f']
    const target  = ['f', 'd', 'a', 'e', 'b', 'c']
    expect(applyMoves(current, minimalMoves(current, target))).toEqual(target)
  })

  it('ignores a post that vanished from Instagram between syncs', () => {
    // 'gone' was deleted in the app; no instruction may reference it.
    const moves = minimalMoves(['a', 'gone', 'b'], ['b', 'a'])
    expect(moves.every(m => m.key !== 'gone')).toBe(true)
    expect(applyMoves(['a', 'b'], moves)).toEqual(['b', 'a'])
  })

  it('does nothing for grids of 0 or 1', () => {
    expect(minimalMoves([], [])).toEqual([])
    expect(minimalMoves(['a'], ['a'])).toEqual([])
  })

  it('reports afterKey as the true predecessor at that moment', () => {
    // Not asserting WHICH tile gets moved: swapping the last two is solvable
    // by moving either one, and both are minimal. What must hold is that
    // afterKey names the tile the moved one actually lands behind.
    const current = ['a', 'b', 'c']
    const target = ['a', 'c', 'b']
    const moves = minimalMoves(current, target)
    expect(moves).toHaveLength(1)

    let grid = [...current]
    for (const m of moves) {
      grid = grid.filter(k => k !== m.key)
      grid.splice(m.toIndex, 0, m.key)
      const idx = grid.indexOf(m.key)
      expect(m.afterKey).toBe(idx > 0 ? grid[idx - 1] : null)
    }
    expect(grid).toEqual(target)
  })

  // The correctness guarantee, checked over many random permutations rather
  // than a handful of hand-picked cases.
  it('always reaches the target, for 300 random shuffles', () => {
    let rng = 12345
    const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff

    for (let trial = 0; trial < 300; trial++) {
      const n = 2 + Math.floor(rand() * 14)
      const current = grid(n)
      const target = [...current]
      for (let i = target.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1))
        ;[target[i], target[j]] = [target[j], target[i]]
      }
      const moves = minimalMoves(current, target)
      expect(applyMoves(current, moves)).toEqual(target)
      // and never more than the theoretical minimum
      const pos = current.map(k => target.indexOf(k))
      expect(moves.length).toBe(n - longestIncreasingSubsequence(pos).length)
    }
  })
})

describe('gridPosition', () => {
  it('maps the first row', () => {
    expect(gridPosition(0)).toEqual({ row: 1, col: 1 })
    expect(gridPosition(2)).toEqual({ row: 1, col: 3 })
  })

  it('wraps to the next row after three', () => {
    expect(gridPosition(3)).toEqual({ row: 2, col: 1 })
    expect(gridPosition(7)).toEqual({ row: 3, col: 2 })
  })
})

describe('pinChanges', () => {
  it('spots what to pin and what to unpin', () => {
    const c = pinChanges(['a'], ['b', 'c'])
    expect(c.pin).toEqual(['b', 'c'])
    expect(c.unpin).toEqual(['a'])
  })

  it('leaves an unchanged pin alone', () => {
    expect(pinChanges(['a', 'b'], ['a', 'b'])).toEqual({ pin: [], unpin: [] })
  })

  it("respects Instagram's cap of three", () => {
    const c = pinChanges([], ['a', 'b', 'c', 'd'])
    expect(c.pin).toHaveLength(MAX_PINNED)
    expect(c.pin).not.toContain('d')
  })
})

describe('effectiveTarget', () => {
  it('lifts pinned posts to the top, as Instagram does', () => {
    expect(effectiveTarget(['a', 'b', 'c', 'd'], ['c'])).toEqual(['c', 'a', 'b', 'd'])
  })

  it('never describes a grid Instagram cannot render', () => {
    // More than three pins requested: only three can actually be pinned.
    const out = effectiveTarget(['a', 'b', 'c', 'd', 'e'], ['e', 'd', 'c', 'b'])
    expect(out.slice(0, MAX_PINNED)).toEqual(['e', 'd', 'c'])
    expect(out).toHaveLength(5)
  })

  it('ignores a pin for a post no longer in the grid', () => {
    expect(effectiveTarget(['a', 'b'], ['ghost'])).toEqual(['a', 'b'])
  })
})

describe('isInSync', () => {
  it('is true when nothing needs doing', () => {
    expect(isInSync(['a', 'b'], ['a', 'b'], ['a'], ['a'])).toBe(true)
  })

  it('is false when only a pin differs', () => {
    // Order matches, but a pin still has to be tapped.
    expect(isInSync(['a', 'b'], ['a', 'b'], [], ['a'])).toBe(false)
  })

  it('is false when only the order differs', () => {
    expect(isInSync(['a', 'b'], ['b', 'a'], [], [])).toBe(false)
  })
})
