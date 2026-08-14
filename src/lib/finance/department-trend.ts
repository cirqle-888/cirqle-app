/**
 * Finance Engine — one department's trend over time (pure).
 *
 * The comparison table (department-pnl.ts) answers "which discipline is worth
 * most right now". This answers the other question: "is it growing?" — which a
 * single period total cannot show, however precise it is.
 *
 * WHOLE MONTHS ONLY. A trend built from a part-month tail always looks like a
 * collapse, because the last bar is a fraction of a month next to full ones.
 * Callers must pass whole calendar months; the page enforces it by snapping the
 * range outward before it gets here.
 *
 * ── When a growth percentage is a lie ────────────────────────────────────────
 *
 * Percentage growth is undefined, not zero, in three cases, and this module
 * returns `null` for each rather than a number that reads as fact:
 *
 *   prior = 0   — "infinite growth". A department's first month of revenue is
 *                 not ∞% growth, it is a start. The UI shows "new".
 *   prior < 0   — the sign flip makes the ratio meaningless.
 *   no prior    — the first month in the window has nothing to compare to.
 *
 * Averaging MoM rates is likewise only done over the DEFINED ones, so a single
 * dormant month cannot silently drag an average toward zero.
 *
 * ── Why half-over-half sits next to the average ──────────────────────────────
 *
 * Mean MoM growth is fragile: one 10× month dominates it forever. Comparing
 * the mean of the later half to the mean of the earlier half is far harder to
 * fool with a single spike, so both are reported and labelled. When they
 * disagree, that disagreement IS the finding — it means the trend is being
 * carried by one month.
 */

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100
const pct1 = (v: number) => Math.round(v * 1000) / 10

/** One month of a department's measured activity. */
export interface DepartmentMonthPoint {
  /** YYYY-MM. */
  month: string
  revenueInr: number
  directLabourInr: number
  taskCount: number
}

export interface DepartmentTrendRow extends DepartmentMonthPoint {
  contributionMarginInr: number
  contributionMarginPct: number
  /** Revenue ÷ tasks. 0 when the month had no tasks. */
  avgTicketInr: number
  /** MoM revenue growth %. Null when undefined — see the module note. */
  revenueGrowthPct: number | null
  /** True when there was no prior revenue to grow from (a start, not a fall). */
  isNewStart: boolean
  /** Revenue indexed to the first active month (=100). Null before it. */
  indexVsStart: number | null
}

export interface DepartmentTrend {
  rows: DepartmentTrendRow[]
  totalRevenueInr: number
  totalLabourInr: number
  totalMarginInr: number
  totalTaskCount: number
  /** Margin ÷ revenue across the whole window. */
  marginPct: number
  /** Months with any revenue or any task. */
  activeMonths: number
  /** Mean of the DEFINED MoM growth rates. Null when none are defined. */
  avgMonthlyGrowthPct: number | null
  /** Later-half mean ÷ earlier-half mean − 1. Null when the earlier half is 0. */
  halfOverHalfPct: number | null
  /** Highest / lowest revenue month among ACTIVE months. */
  bestMonth: DepartmentTrendRow | null
  worstMonth: DepartmentTrendRow | null
  /** Last month vs the one before it — the "latest move". */
  latestGrowthPct: number | null
}

/**
 * Growth from `prior` to `curr`, or null when a percentage cannot describe it.
 */
export function growthPct(curr: number, prior: number): number | null {
  if (!Number.isFinite(curr) || !Number.isFinite(prior)) return null
  if (prior <= 0) return null
  return pct1((curr - prior) / prior)
}

/**
 * Build the trend. `points` must be whole months in ascending order; months
 * with no activity should still be present (as zeroes) so a gap is visible as
 * a gap rather than closing up into a smooth line.
 */
export function buildDepartmentTrend(points: DepartmentMonthPoint[]): DepartmentTrend {
  const ordered = [...points].sort((a, b) => a.month.localeCompare(b.month))

  let baseline: number | null = null
  const rows: DepartmentTrendRow[] = ordered.map((p, i) => {
    const margin = r2(p.revenueInr - p.directLabourInr)
    const prior = i > 0 ? ordered[i - 1].revenueInr : null
    if (baseline == null && p.revenueInr > 0) baseline = p.revenueInr
    return {
      ...p,
      revenueInr: r2(p.revenueInr),
      directLabourInr: r2(p.directLabourInr),
      contributionMarginInr: margin,
      contributionMarginPct: p.revenueInr > 0 ? pct1(margin / p.revenueInr) : 0,
      avgTicketInr: p.taskCount > 0 ? r2(p.revenueInr / p.taskCount) : 0,
      revenueGrowthPct: prior == null ? null : growthPct(p.revenueInr, prior),
      isNewStart: prior != null && prior <= 0 && p.revenueInr > 0,
      indexVsStart: baseline && baseline > 0 ? pct1(p.revenueInr / baseline) : null,
    }
  })

  const sum = (f: (r: DepartmentTrendRow) => number) => r2(rows.reduce((s, r) => s + f(r), 0))
  const totalRevenueInr = sum(r => r.revenueInr)
  const totalLabourInr = sum(r => r.directLabourInr)
  const totalMarginInr = r2(totalRevenueInr - totalLabourInr)

  const active = rows.filter(r => r.revenueInr !== 0 || r.taskCount > 0)

  const defined = rows.map(r => r.revenueGrowthPct).filter((v): v is number => v != null)
  const avgMonthlyGrowthPct = defined.length > 0
    ? pct1(defined.reduce((s, v) => s + v, 0) / defined.length / 100)
    : null

  // Split on the midpoint; with an odd count the middle month goes to the later
  // half, so the most recent evidence is never the half that gets shortened.
  let halfOverHalfPct: number | null = null
  if (rows.length >= 2) {
    const mid = Math.floor(rows.length / 2)
    const early = rows.slice(0, mid)
    const late = rows.slice(mid)
    const mean = (xs: DepartmentTrendRow[]) => xs.reduce((s, r) => s + r.revenueInr, 0) / xs.length
    const e = mean(early)
    if (e > 0) halfOverHalfPct = pct1((mean(late) - e) / e)
  }

  const byRevenue = [...active].sort((a, b) => b.revenueInr - a.revenueInr)

  return {
    rows,
    totalRevenueInr,
    totalLabourInr,
    totalMarginInr,
    totalTaskCount: rows.reduce((s, r) => s + r.taskCount, 0),
    marginPct: totalRevenueInr > 0 ? pct1(totalMarginInr / totalRevenueInr) : 0,
    activeMonths: active.length,
    avgMonthlyGrowthPct,
    halfOverHalfPct,
    bestMonth: byRevenue[0] ?? null,
    worstMonth: byRevenue.length > 1 ? byRevenue[byRevenue.length - 1] : null,
    latestGrowthPct: rows.length > 0 ? rows[rows.length - 1].revenueGrowthPct : null,
  }
}

// ── Mix: what the department is made of ──────────────────────────────────────

export interface MixInput {
  id: string
  label: string
  revenueInr: number
  taskCount: number
}

export interface MixRow extends MixInput {
  sharePct: number
}

/**
 * Rank the parts of a department by revenue, with each one's share.
 *
 * Share is of the POSITIVE total, so a refunded line cannot inflate everyone
 * else's percentage past 100.
 */
export function buildMix(items: MixInput[]): MixRow[] {
  const merged = new Map<string, MixInput>()
  for (const i of items) {
    const cur = merged.get(i.id)
    if (cur) {
      cur.revenueInr = r2(cur.revenueInr + i.revenueInr)
      cur.taskCount += i.taskCount
    } else {
      merged.set(i.id, { ...i, revenueInr: r2(i.revenueInr) })
    }
  }
  const rows = [...merged.values()]
  const total = rows.reduce((s, r) => s + Math.max(0, r.revenueInr), 0)
  return rows
    .map(r => ({ ...r, sharePct: total > 0 ? pct1(Math.max(0, r.revenueInr) / total) : 0 }))
    .sort((a, b) => b.revenueInr - a.revenueInr)
}
