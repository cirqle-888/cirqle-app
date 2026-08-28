/**
 * Turning a desired grid into the fewest taps on a phone.
 *
 * Instagram's Grid Reorder (8 June 2026) and pinning are BOTH app-only. Meta's
 * media endpoint accepts exactly one writable field, comment_enabled — there is
 * no pin endpoint and no position field, and pinned state cannot even be read
 * back. So Cirqle cannot move a live post; a person does that on their phone.
 *
 * What Cirqle can do is make it short. Dragging a grid into shape by hand is
 * guesswork — you cannot see how many moves are left, and every move shifts
 * everything after it. This computes the PROVABLY MINIMAL set of moves: the
 * posts already in the right relative order stay put, and only the rest are
 * touched.
 *
 * Pure functions, no imports — the same rules serve the planner, the
 * instruction list and the tests.
 *
 * WE CANNOT SEE THE LIVE GRID. The API returns media by date, with no
 * position. So `current` is what Cirqle BELIEVES is live: newest-first until
 * someone records an applied layout, and the applied layout thereafter. If she
 * reorders on her phone without saying so, the instructions drift — which is
 * why they are guidance and never a source of truth.
 */

/** Instagram's cap. Pinned posts sit above everything else, and it is 3. */
export const MAX_PINNED = 3

/** Instagram's profile grid is three across. */
export const GRID_COLUMNS = 3

export interface Move {
  /** Tile key being moved. */
  key: string
  /** Its index AFTER the move, in the grid as it stands at that moment. */
  toIndex: number
  /** The tile it should end up immediately after — null means "to the front". */
  afterKey: string | null
}

/** Human grid coordinates, 1-based, for "row 2, position 3". */
export function gridPosition(index: number, columns: number = GRID_COLUMNS): { row: number; col: number } {
  return { row: Math.floor(index / columns) + 1, col: (index % columns) + 1 }
}

/**
 * Indices of a longest increasing subsequence of `nums`.
 *
 * These are the posts that are ALREADY in the right order relative to each
 * other. Leaving them alone is what makes the move count minimal: every
 * element outside the LIS must be repositioned, and no solution can do better
 * than n − |LIS|.
 */
export function longestIncreasingSubsequence(nums: number[]): number[] {
  if (nums.length === 0) return []
  // tails[l] = index into nums of the smallest tail of an increasing
  // subsequence of length l+1. prev[] reconstructs the chain.
  const tails: number[] = []
  const prev: number[] = new Array(nums.length).fill(-1)

  for (let i = 0; i < nums.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (nums[tails[mid]] < nums[i]) lo = mid + 1
      else hi = mid
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1
    tails[lo] = i
    if (lo === tails.length) tails.push(i)
  }

  const out: number[] = []
  let k = tails[tails.length - 1]
  while (k !== -1) { out.push(k); k = prev[k] }
  return out.reverse()
}

/**
 * The fewest "pick this up and drop it there" moves taking `current` to
 * `target`.
 *
 * Both must hold the same keys; anything in `current` that is missing from
 * `target` is ignored, so a post deleted on Instagram between syncs cannot
 * produce an instruction referring to something that is no longer there.
 *
 * Each move's `toIndex` is correct AT THE MOMENT IT IS PERFORMED, because the
 * grid is simulated step by step — otherwise every instruction after the first
 * would be off, which is exactly what makes doing this by hand so annoying.
 */
export function minimalMoves(current: string[], target: string[]): Move[] {
  const targetIndex = new Map<string, number>()
  target.forEach((k, i) => targetIndex.set(k, i))

  // Only keys the target still knows about.
  const live = current.filter(k => targetIndex.has(k))
  if (live.length <= 1) return []

  const positions = live.map(k => targetIndex.get(k) as number)
  const keepIdx = longestIncreasingSubsequence(positions)
  const keep = new Set(keepIdx.map(i => live[i]))

  // Move the rest, in target order, so each lands among already-correct
  // neighbours rather than being shuffled twice.
  const moving = target.filter(k => targetIndex.has(k) && !keep.has(k) && live.includes(k))

  let grid = [...live]
  const moves: Move[] = []

  // Tiles whose position is SETTLED: the untouched run, plus everything moved
  // so far. Only these may decide where the next tile lands. A tile still
  // waiting its turn is sitting somewhere arbitrary, and measuring against it
  // drops the next tile in the wrong place — the bug that made p9 land ahead
  // of p2 instead of behind it.
  const placed = new Set(keep)

  for (const key of moving) {
    grid = grid.filter(k => k !== key)
    const mine = targetIndex.get(key) as number

    let insertAt = grid.length
    for (let i = 0; i < grid.length; i++) {
      if (!placed.has(grid[i])) continue
      if ((targetIndex.get(grid[i]) as number) > mine) { insertAt = i; break }
    }

    grid.splice(insertAt, 0, key)
    placed.add(key)
    moves.push({
      key,
      toIndex: insertAt,
      afterKey: insertAt > 0 ? grid[insertAt - 1] : null,
    })
  }

  return moves
}

/** Replay moves onto a grid. Used by the tests to prove the instructions work. */
export function applyMoves(current: string[], moves: Move[]): string[] {
  let grid = [...current]
  for (const m of moves) {
    grid = grid.filter(k => k !== m.key)
    grid.splice(m.toIndex, 0, m.key)
  }
  return grid
}

export interface PinChange {
  pin: string[]
  unpin: string[]
}

/**
 * Which posts to pin and unpin.
 *
 * Pinning is its own action in Instagram, separate from dragging, so it is its
 * own instruction. Order within the pinned set is not compared: Instagram
 * decides how pinned posts sit relative to each other, and pretending
 * otherwise would produce moves that cannot be carried out.
 */
export function pinChanges(currentPinned: string[], targetPinned: string[]): PinChange {
  const now = new Set(currentPinned)
  const want = new Set(targetPinned.slice(0, MAX_PINNED))
  return {
    pin: Array.from(want).filter(k => !now.has(k)),
    unpin: Array.from(now).filter(k => !want.has(k)),
  }
}

/**
 * The order a viewer actually sees: pinned first, then everything else in the
 * planned order. Pinned posts are locked to the top by Instagram, so a target
 * that ignored that would be describing a grid that cannot exist.
 */
export function effectiveTarget(order: string[], pinned: string[]): string[] {
  const pins = pinned.slice(0, MAX_PINNED).filter(k => order.includes(k))
  const rest = order.filter(k => !pins.includes(k))
  return [...pins, ...rest]
}

/** True when the live grid already matches the target — nothing to do. */
export function isInSync(current: string[], target: string[], currentPinned: string[], targetPinned: string[]): boolean {
  const c = pinChanges(currentPinned, targetPinned)
  return minimalMoves(current, target).length === 0 && c.pin.length === 0 && c.unpin.length === 0
}
