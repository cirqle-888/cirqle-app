/**
 * Finance Engine — dashboard trend series + period comparison (pure).
 *
 * Powers the main dashboard graph: jobs received, cash inflow/outflow and the
 * running bank balance, bucketed by day or month, with a "current vs previous
 * period" overlay (this month vs last month, this year vs last year, or any
 * custom range vs the same number of days immediately before it).
 *
 * All functions are pure over date-only strings (YYYY-MM-DD) — no Supabase,
 * no timezone surprises, fully unit-tested.
 */

export type ComparisonMode = 'week' | 'month' | 'quarter' | 'year' | 'custom'
export type TrendGranularity = 'day' | 'month'

export interface PeriodRange { from: string; to: string }   // inclusive bounds

export interface TrendCashPoint { date: string; type: 'inflow' | 'outflow'; amountInr: number }
/**
 * `valueInr` is the task's billing_amount_inr — already the TOTAL for the task,
 * never a unit price. Every other dashboard aggregation sums it raw (see
 * dashboard-analytics.tsx), so multiplying by `quantity` here would silently
 * disagree with "Total Billed" on the same screen. Optional: absent means 0,
 * which keeps callers that only track counts working unchanged.
 */
export interface TrendTaskPoint { date: string; valueInr?: number }

export interface TrendBucket {
  key: string          // YYYY-MM-DD (day) or YYYY-MM (month)
  label: string        // short display label, e.g. "7 Jul" / "Jul 26"
  jobs: number         // tasks received (count by task_date)
  jobValueInr: number  // billing value of those same tasks
  inflowInr: number
  outflowInr: number
  balanceInr: number   // running bank balance at END of bucket (all-time cumulative)
}

// ── Date helpers (local-safe, string in/string out) ──────────────────────────

const pad = (n: number) => String(n).padStart(2, '0')
const toKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }

// YYYY-MM-DD strings compare lexicographically like dates, so plain `>` works.
const clampToToday = (end: string, today: string) => (end > today ? today : end)

export function addDays(date: string, n: number): string {
  const d = parse(date); d.setDate(d.getDate() + n); return toKey(d)
}

/** Inclusive day count of a range ("2026-07-01".."2026-07-03" = 3). */
export function rangeDays(range: PeriodRange): number {
  return Math.round((parse(range.to).getTime() - parse(range.from).getTime()) / 86_400_000) + 1
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayLabel = (key: string) => { const d = parse(key); return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}` }
const monthLabel = (key: string) => {
  const [y, m] = key.split('-').map(Number)
  return `${MONTHS_SHORT[m - 1]} ${String(y).slice(2)}`
}

// ── Period resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the current + previous period for a comparison mode.
 *
 *   week     Mon–Sun containing `today`  vs the week before
 *   month    calendar month              vs the month before
 *   quarter  calendar quarter            vs the quarter before
 *   year     calendar year (monthly)     vs the year before
 *   custom   the given range             vs the same NUMBER OF DAYS ending
 *                                        the day before the range starts
 *
 * Buckets are aligned by index (day 1 vs day 1, month 1 vs month 1), the
 * standard way period-over-period charts line up.
 */
export function resolveComparisonPeriods(
  mode: ComparisonMode,
  today: string,
  custom?: PeriodRange,
): { current: PeriodRange; previous: PeriodRange; granularity: TrendGranularity } {
  const t = parse(today)
  const y = t.getFullYear(), m = t.getMonth()

  if (mode === 'week') {
    const dow = (t.getDay() + 6) % 7                       // Monday = 0
    const from = addDays(today, -dow)
    return {
      current: { from, to: clampToToday(addDays(from, 6), today) },
      previous: { from: addDays(from, -7), to: addDays(from, -1) },
      granularity: 'day',
    }
  }
  if (mode === 'month') {
    return {
      current: { from: toKey(new Date(y, m, 1)), to: clampToToday(toKey(new Date(y, m + 1, 0)), today) },
      previous: { from: toKey(new Date(y, m - 1, 1)), to: toKey(new Date(y, m, 0)) },
      granularity: 'day',
    }
  }
  if (mode === 'quarter') {
    const q = Math.floor(m / 3) * 3
    return {
      current: { from: toKey(new Date(y, q, 1)), to: clampToToday(toKey(new Date(y, q + 3, 0)), today) },
      previous: { from: toKey(new Date(y, q - 3, 1)), to: toKey(new Date(y, q, 0)) },
      granularity: 'day',
    }
  }
  if (mode === 'year') {
    return {
      current: { from: `${y}-01-01`, to: clampToToday(`${y}-12-31`, today) },
      previous: { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
      granularity: 'month',
    }
  }
  // custom: previous = same length immediately before, back-to-back.
  const range = custom ?? { from: addDays(today, -29), to: today }
  const len = rangeDays(range)
  return {
    current: range,
    previous: { from: addDays(range.from, -len), to: addDays(range.from, -1) },
    granularity: len > 92 ? 'month' : 'day',
  }
}

// ── Series building ───────────────────────────────────────────────────────────

function bucketKeys(period: PeriodRange, granularity: TrendGranularity): string[] {
  const keys: string[] = []
  if (granularity === 'day') {
    for (let k = period.from; k <= period.to; k = addDays(k, 1)) keys.push(k)
  } else {
    let [y, m] = period.from.split('-').map(Number)
    const [ty, tm] = period.to.split('-').map(Number)
    while (y < ty || (y === ty && m <= tm)) {
      keys.push(`${y}-${pad(m)}`)
      m += 1; if (m > 12) { m = 1; y += 1 }
    }
  }
  return keys
}

const keyOf = (date: string, granularity: TrendGranularity) =>
  granularity === 'day' ? date : date.slice(0, 7)

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100

/**
 * Bucket cash + task points into a trend series for one period.
 *
 * `cash` must be the FULL ledger (all-time): the running bank balance needs
 * the opening balance — everything that happened before `period.from`.
 */
export function buildTrendSeries(
  inputs: { cash: TrendCashPoint[]; tasks: TrendTaskPoint[] },
  period: PeriodRange,
  granularity: TrendGranularity,
): TrendBucket[] {
  const keys = bucketKeys(period, granularity)
  const index = new Map<string, TrendBucket>(keys.map(k => [k, {
    key: k,
    label: granularity === 'day' ? dayLabel(k) : monthLabel(k),
    jobs: 0, jobValueInr: 0, inflowInr: 0, outflowInr: 0, balanceInr: 0,
  }]))

  let opening = 0
  for (const c of inputs.cash) {
    if (!c.date) continue
    const signed = c.type === 'inflow' ? c.amountInr : -c.amountInr
    if (c.date < period.from) { opening += signed; continue }
    if (c.date > period.to) continue
    const b = index.get(keyOf(c.date, granularity))
    if (!b) continue
    if (c.type === 'inflow') b.inflowInr = r2(b.inflowInr + c.amountInr)
    else b.outflowInr = r2(b.outflowInr + c.amountInr)
  }

  for (const t of inputs.tasks) {
    if (!t.date || t.date < period.from || t.date > period.to) continue
    const b = index.get(keyOf(t.date, granularity))
    if (!b) continue
    b.jobs += 1
    // Counted on the SAME pass as the job itself, so the two series can never
    // disagree about which tasks are in a bucket.
    b.jobValueInr = r2(b.jobValueInr + (Number(t.valueInr) || 0))
  }

  let running = r2(opening)
  for (const k of keys) {
    const b = index.get(k)!
    running = r2(running + b.inflowInr - b.outflowInr)
    b.balanceInr = running
  }
  return keys.map(k => index.get(k)!)
}

// ── Comparison alignment ──────────────────────────────────────────────────────

/** One chart row: current-period bucket + the same-index previous bucket. */
export interface ComparisonRow {
  label: string
  prevLabel?: string
  jobs?: number; jobValueInr?: number; inflowInr?: number; outflowInr?: number; balanceInr?: number
  prev_jobs?: number; prev_jobValueInr?: number
  prev_inflowInr?: number; prev_outflowInr?: number; prev_balanceInr?: number
}

/**
 * Zip two series by bucket index (day N of this month lines up with day N of
 * last month). The longer series decides the row count; the shorter one's
 * values are simply absent (Recharts skips undefined points).
 */
export function alignComparison(current: TrendBucket[], previous: TrendBucket[]): ComparisonRow[] {
  const rows: ComparisonRow[] = []
  const n = Math.max(current.length, previous.length)
  for (let i = 0; i < n; i++) {
    const c = current[i], p = previous[i]
    rows.push({
      label: c?.label ?? p?.label ?? '',
      prevLabel: p?.label,
      ...(c ? { jobs: c.jobs, jobValueInr: c.jobValueInr, inflowInr: c.inflowInr, outflowInr: c.outflowInr, balanceInr: c.balanceInr } : {}),
      ...(p ? { prev_jobs: p.jobs, prev_jobValueInr: p.jobValueInr, prev_inflowInr: p.inflowInr, prev_outflowInr: p.outflowInr, prev_balanceInr: p.balanceInr } : {}),
    })
  }
  return rows
}

// ── Totals (for the delta chips above the graph) ─────────────────────────────

export interface TrendTotals {
  jobs: number
  jobValueInr: number
  inflowInr: number
  outflowInr: number
  /** Balance at period end (running), not a sum. */
  endBalanceInr: number
}

export function seriesTotals(buckets: TrendBucket[]): TrendTotals {
  return {
    jobs: buckets.reduce((s, b) => s + b.jobs, 0),
    jobValueInr: r2(buckets.reduce((s, b) => s + b.jobValueInr, 0)),
    inflowInr: r2(buckets.reduce((s, b) => s + b.inflowInr, 0)),
    outflowInr: r2(buckets.reduce((s, b) => s + b.outflowInr, 0)),
    endBalanceInr: buckets.length ? buckets[buckets.length - 1].balanceInr : 0,
  }
}

/** % change (1 decimal), null when the previous value is 0/absent. */
export function pctChange(current: number, previous: number | undefined | null): number | null {
  if (previous == null || previous === 0) return null
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10
}
