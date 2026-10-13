/**
 * Grouping the cash book by day.
 *
 * The entries list is one flat run of rows. Reading it means working out where
 * one day ends and the next begins from the small date under each
 * description — which is exactly the question somebody reconciling a bank
 * statement is asking on every single row.
 *
 * Grouping answers it once per day, and lets the day carry its own totals:
 * "9 October, 4 entries, ₹1,200 in, ₹5,353 out" is the line a reconciliation
 * actually needs.
 *
 * ── DATES ARE CALENDAR DATES ──────────────────────────────────────────────
 *
 * `entry_date` is a DATE column, stored as YYYY-MM-DD. It is grouped and
 * sorted as that string, never through `new Date()`: parsing it would drag it
 * through the process timezone, and an entry dated the 1st would fall into the
 * previous day for anyone behind UTC. The repo already learned this — see
 * lib/utils/local-date — and a grouping that disagreed with the date printed
 * on the row would be worse than no grouping at all.
 *
 * Pure and dependency-free.
 */

export interface DayGroup<T> {
  /** The YYYY-MM-DD the group covers; '' for entries with no date. */
  key: string
  rows: T[]
  /** Totals across the group, in the base currency the rows carry. */
  inflow: number
  outflow: number
  /** inflow − outflow. Negative means the day cost more than it brought in. */
  net: number
}

export interface DayGroupFields<T> {
  /** The row's calendar date, as stored (YYYY-MM-DD). */
  date: (row: T) => string | null | undefined
  /** Signed or unsigned amount in the base currency; sign is taken from `type`. */
  amount: (row: T) => number
  /** Which side of the book the row is on. */
  isInflow: (row: T) => boolean
}

/** Just the date part, so a timestamp groups with the day it falls on. */
function dayKey(value: string | null | undefined): string {
  if (typeof value !== 'string') return ''
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim())
  return match ? match[1] : ''
}

/**
 * Split rows into one group per calendar day.
 *
 * Input order is preserved INSIDE each group, and the groups come back in the
 * order their first row appeared — so the list's own sort (newest first, or
 * oldest first) carries straight through rather than being imposed again here
 * and then disagreeing with the toolbar.
 *
 * Undated rows collect under a single `''` group, placed last: they are a data
 * problem to notice, not a day.
 */
export function groupByDay<T>(rows: readonly T[], fields: DayGroupFields<T>): DayGroup<T>[] {
  const groups: DayGroup<T>[] = []
  const byKey = new Map<string, DayGroup<T>>()

  for (const row of rows) {
    const key = dayKey(fields.date(row))
    let group = byKey.get(key)
    if (!group) {
      group = { key, rows: [], inflow: 0, outflow: 0, net: 0 }
      byKey.set(key, group)
      groups.push(group)
    }
    group.rows.push(row)
    // Magnitude, not sign: an outflow may be stored either way depending on
    // where the row came from, and `isInflow` is the authority on direction.
    const amount = Math.abs(Number(fields.amount(row)) || 0)
    if (fields.isInflow(row)) group.inflow += amount
    else group.outflow += amount
  }

  for (const group of groups) group.net = group.inflow - group.outflow

  // Undated last, wherever they turned up.
  const dated = groups.filter(g => g.key !== '')
  const undated = groups.filter(g => g.key === '')
  return [...dated, ...undated]
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

/**
 * A day heading: "Today", "Yesterday", or "Thursday, 9 October 2026".
 *
 * Built from the string's own parts rather than `toLocaleDateString`, for the
 * same reason the grouping is: a calendar date must not be pushed across a day
 * boundary by the reader's timezone. `today` is passed in (as YYYY-MM-DD) so
 * the caller decides what "today" means — the app resolves it in Asia/Kolkata.
 */
export function dayGroupLabel(key: string, today?: string): string {
  if (!key) return 'No date'
  const [y, m, d] = key.split('-').map(Number)
  // Range-checked, not merely present: a month of 13 formatted as
  // "99 undefined 2026" rather than falling back to the stored value.
  if (!(y >= 1000 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return key

  if (today) {
    if (key === today) return 'Today'
    const [ty, tm, td] = today.split('-').map(Number)
    // One day back, in UTC so the arithmetic cannot wander either.
    const yesterday = new Date(Date.UTC(ty, tm - 1, td - 1)).toISOString().slice(0, 10)
    if (key === yesterday) return 'Yesterday'
  }

  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${weekday}, ${d} ${MONTHS[m - 1]} ${y}`
}
