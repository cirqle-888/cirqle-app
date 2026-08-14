/**
 * Does the planned grid hang together visually?
 *
 * A feed is judged as a whole, so the useful questions are about relationships
 * between tiles, not any one tile: do two loud images sit next to each other,
 * has the palette drifted, is every post the same brightness?
 *
 * Pure and deterministic — colour is extracted in the browser (canvas) and the
 * verdict computed here, so the rule is testable without a DOM and identical in
 * the planner and any future report.
 *
 * Deliberately advisory. It reports observations, never blocks anything: a
 * deliberate clash is a legitimate design choice and the tool has no business
 * overriding a designer.
 */

/** Average colour of one tile, 0-255 per channel. */
export interface TileColor {
  key: string
  r: number
  g: number
  b: number
}

export interface HarmonyFinding {
  /** 'clash' is about neighbours; the rest are about the feed as a whole. */
  kind: 'clash' | 'monotony' | 'brightness_swing' | 'off_palette'
  message: string
  /** Tiles the finding refers to, so the UI can point at them. */
  keys: string[]
  severity: 'info' | 'warn'
}

export interface HarmonyReport {
  findings: HarmonyFinding[]
  /** 0-100. Not a grade — a rough summary of how settled the grid looks. */
  score: number
  /** Mean brightness, 0-255, for the "is the feed dark or light?" question. */
  averageBrightness: number
}

/** Perceived brightness (ITU-R BT.601) — matches how the eye weights channels. */
export function brightnessOf(c: TileColor): number {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b
}

/** Straight-line distance in RGB. Crude, but stable and easy to reason about. */
export function colorDistance(a: TileColor, b: TileColor): number {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

/** Max possible RGB distance — used to normalise into percentages. */
const MAX_DISTANCE = Math.sqrt(3 * 255 * 255)

/**
 * Two adjacent tiles this far apart read as a jolt rather than a transition.
 * Tuned high: Instagram grids are meant to have variety, and a nagging tool
 * gets switched off.
 */
const CLASH_DISTANCE = 165

/** Below this average spread, the feed is same-y rather than cohesive. */
const MONOTONY_DISTANCE = 22

/** Brightness spread beyond this makes the grid look patchy. */
const BRIGHTNESS_SWING = 110

/** How far from the brand palette a tile may sit before it looks off-brand. */
const OFF_PALETTE_DISTANCE = 150

/**
 * Neighbours in a 3-column grid: the tile to the right (same row) and the tile
 * below. Diagonals are excluded — the eye reads rows and columns, and counting
 * diagonals produces findings nobody recognises.
 */
export function neighbourPairs(count: number, columns = 3): [number, number][] {
  const pairs: [number, number][] = []
  for (let i = 0; i < count; i++) {
    const sameRow = i % columns !== columns - 1
    if (sameRow && i + 1 < count) pairs.push([i, i + 1])
    if (i + columns < count) pairs.push([i, i + columns])
  }
  return pairs
}

export interface HarmonyInput {
  colors: TileColor[]
  /** Optional brand colours to measure drift against. */
  palette?: TileColor[]
}

export function analyseHarmony(input: HarmonyInput): HarmonyReport {
  const colors = input.colors
  const findings: HarmonyFinding[] = []

  // Two tiles cannot clash, and one cannot be monotonous. Below three, the
  // honest answer is "not enough to judge".
  if (colors.length < 3) {
    return { findings, score: 100, averageBrightness: colors.length ? mean(colors.map(brightnessOf)) : 0 }
  }

  const brightnesses = colors.map(brightnessOf)
  const averageBrightness = mean(brightnesses)

  // ── Neighbour clashes ──────────────────────────────────────────────────────
  const pairs = neighbourPairs(colors.length)
  const clashes = pairs.filter(([a, b]) => colorDistance(colors[a], colors[b]) > CLASH_DISTANCE)
  for (const [a, b] of clashes.slice(0, 4)) {
    findings.push({
      kind: 'clash',
      severity: 'info',
      message: 'These two sit side by side and jump in colour — worth checking they read as intentional.',
      keys: [colors[a].key, colors[b].key],
    })
  }

  // ── Overall spread ─────────────────────────────────────────────────────────
  const spread = mean(pairs.map(([a, b]) => colorDistance(colors[a], colors[b])))
  if (spread < MONOTONY_DISTANCE) {
    findings.push({
      kind: 'monotony',
      severity: 'info',
      message: 'Every tile is close to the same colour. Cohesive, but the grid may read as flat — one contrasting post would give it rhythm.',
      keys: colors.map(c => c.key),
    })
  }

  // ── Brightness patchiness ──────────────────────────────────────────────────
  const bMin = Math.min(...brightnesses), bMax = Math.max(...brightnesses)
  if (bMax - bMin > BRIGHTNESS_SWING) {
    const darkest = colors[brightnesses.indexOf(bMin)]
    const lightest = colors[brightnesses.indexOf(bMax)]
    findings.push({
      kind: 'brightness_swing',
      severity: 'warn',
      message: 'The grid swings hard between very dark and very light posts, which tends to look patchy at profile size.',
      keys: [darkest.key, lightest.key],
    })
  }

  // ── Brand palette drift ────────────────────────────────────────────────────
  if (input.palette?.length) {
    const off = colors.filter(c =>
      Math.min(...input.palette!.map(p => colorDistance(c, p))) > OFF_PALETTE_DISTANCE)
    if (off.length) {
      findings.push({
        kind: 'off_palette',
        severity: 'warn',
        message: `${off.length} post${off.length === 1 ? '' : 's'} sit${off.length === 1 ? 's' : ''} well outside the client's usual palette.`,
        keys: off.map(c => c.key),
      })
    }
  }

  // A rough summary, not a grade: start at 100 and deduct for what was found.
  let score = 100
  score -= Math.min(30, clashes.length * 6)
  if (spread < MONOTONY_DISTANCE) score -= 10
  if (bMax - bMin > BRIGHTNESS_SWING) score -= 15
  score -= Math.min(20, (findings.find(f => f.kind === 'off_palette')?.keys.length ?? 0) * 5)

  return {
    findings,
    score: Math.max(0, Math.min(100, Math.round(score))),
    averageBrightness: Math.round(averageBrightness),
  }
}

/** Percentage form of a colour distance — for a readable "x% apart". */
export function distancePct(a: TileColor, b: TileColor): number {
  return Math.round((colorDistance(a, b) / MAX_DISTANCE) * 100)
}

function mean(ns: number[]): number {
  return ns.length ? ns.reduce((s, n) => s + n, 0) / ns.length : 0
}
