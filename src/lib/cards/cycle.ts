/**
 * Billing cycles — the windows a card statement covers.
 *
 * A card does not bill by calendar month. A statement day of 16 means the
 * cycle runs the 16th to the 15th, and every question about a cycle — which
 * entries belong to it, which cycle a date falls in, what to offer next —
 * is this file's arithmetic rather than a month lookup.
 *
 * THE CASE THAT BREAKS NAIVE VERSIONS: a statement day of 29, 30 or 31. There
 * is no 31st of February, and rolling forward to 1 March would make February's
 * cycle overlap March's and put the same charge on two statements. The day is
 * CLAMPED to the last day of the short month instead, which is also what card
 * issuers do.
 *
 * Dates are plain 'YYYY-MM-DD' strings throughout. A Date object here would
 * drag the server's timezone into a question that has nothing to do with time
 * of day — the same reason `local-date.ts` exists for the rest of the app.
 */

export interface Cycle {
  /** First day of the cycle, inclusive. */
  start: string
  /** Statement day — last day of the cycle, inclusive. */
  end: string
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/

/** Days in a month. `month` is 1-12. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** The statement day for a given month, clamped to months that are too short. */
export function statementDateIn(year: number, month: number, statementDay: number): string {
  const day = Math.min(Math.max(1, Math.round(statementDay)), daysInMonth(year, month))
  return iso(year, month, day)
}

function parse(date: string): { y: number; m: number; d: number } | null {
  const m = ISO.exec(date)
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return { y, m: mo, d }
}

/** The day after `date`. */
export function nextDay(date: string): string {
  const p = parse(date)
  if (!p) return date
  const last = daysInMonth(p.y, p.m)
  if (p.d < last) return iso(p.y, p.m, p.d + 1)
  return p.m === 12 ? iso(p.y + 1, 1, 1) : iso(p.y, p.m + 1, 1)
}

/**
 * The cycle a date falls in.
 *
 * On the statement day itself the cycle ENDS — a charge made on the 16th with
 * a statement day of 16 is on that statement, not the next one. That is the
 * convention issuers use and the one a person reading a statement expects.
 */
export function cycleFor(date: string, statementDay: number): Cycle | null {
  const p = parse(date)
  if (!p) return null

  const thisMonthEnd = statementDateIn(p.y, p.m, statementDay)
  if (date <= thisMonthEnd) {
    // Ends this month; started the day after last month's statement day.
    const prev = p.m === 1 ? { y: p.y - 1, m: 12 } : { y: p.y, m: p.m - 1 }
    return { start: nextDay(statementDateIn(prev.y, prev.m, statementDay)), end: thisMonthEnd }
  }
  // After this month's statement day, so it belongs to next month's cycle.
  const next = p.m === 12 ? { y: p.y + 1, m: 1 } : { y: p.y, m: p.m + 1 }
  return { start: nextDay(thisMonthEnd), end: statementDateIn(next.y, next.m, statementDay) }
}

/** The cycle before this one. */
export function previousCycle(cycle: Cycle, statementDay: number): Cycle | null {
  const p = parse(cycle.start)
  if (!p) return null
  // The day before this cycle started is the previous statement day.
  const prevEnd = previousDay(cycle.start)
  return cycleFor(prevEnd, statementDay)
}

function previousDay(date: string): string {
  const p = parse(date)
  if (!p) return date
  if (p.d > 1) return iso(p.y, p.m, p.d - 1)
  const prev = p.m === 1 ? { y: p.y - 1, m: 12 } : { y: p.y, m: p.m - 1 }
  return iso(prev.y, prev.m, daysInMonth(prev.y, prev.m))
}

/**
 * Cycles to offer for import, newest first.
 *
 * The cycle containing `today` is EXCLUDED: it has not closed yet, so there is
 * no statement for it and importing one would be importing a guess. Nothing
 * before `from` is offered either — that is the card's clean start, and
 * entries before it predate the card model on purpose.
 */
export function closedCyclesBetween(
  from: string,
  today: string,
  statementDay: number,
  max = 24,
): Cycle[] {
  const current = cycleFor(today, statementDay)
  if (!current) return []
  const out: Cycle[] = []
  let cycle = previousCycle(current, statementDay)
  for (let i = 0; i < max && cycle; i++) {
    if (cycle.end < from) break
    out.push(cycle)
    cycle = previousCycle(cycle, statementDay)
  }
  return out
}

/** Is `date` inside the cycle? Both ends are inclusive. */
export function inCycle(date: string, cycle: Cycle): boolean {
  return date >= cycle.start && date <= cycle.end
}

/** "16 Aug – 15 Sep 2026", for a heading a person has to recognise at a glance. */
export function cycleLabel(cycle: Cycle): string {
  const fmt = (date: string, withYear: boolean) => {
    const p = parse(date)
    if (!p) return date
    const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][p.m - 1]
    return `${p.d} ${month}${withYear ? ' ' + p.y : ''}`
  }
  const a = parse(cycle.start), b = parse(cycle.end)
  const sameYear = a && b && a.y === b.y
  return `${fmt(cycle.start, !sameYear)} – ${fmt(cycle.end, true)}`
}
