import { lastDayOfMonthISO } from '@/lib/utils/local-date'

/**
 * The window a bank statement covers.
 *
 * A card bills on a cycle the issuer chose, which is why `lib/cards/cycle.ts`
 * has arithmetic in it. A BANK statement has no such rule — it covers whatever
 * the person asked the bank for, usually a calendar month but often a quarter,
 * a financial year, or the odd stretch between two dates. So a period is
 * simply a start and an end that get STORED, and this file only offers the
 * months as convenient presets.
 *
 * Dates are plain 'YYYY-MM-DD' strings throughout, for the same reason as
 * everywhere else in the app: a Date object drags the server's timezone into a
 * question that has nothing to do with time of day.
 */

export interface Period {
  /** First day covered, inclusive. */
  start: string
  /** Last day covered, inclusive. */
  end: string
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/

export function isPeriod(value: unknown): value is Period {
  if (!value || typeof value !== 'object') return false
  const p = value as Period
  return ISO.test(p.start ?? '') && ISO.test(p.end ?? '') && p.end >= p.start
}

/** The calendar month containing `date`. */
export function monthPeriod(date: string): Period | null {
  const m = ISO.exec(date)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  if (month < 1 || month > 12) return null
  return { start: `${m[1]}-${m[2]}-01`, end: lastDayOfMonthISO(year, month) }
}

/**
 * Whole months from `from` back through `to`, newest first.
 *
 * Offered as presets in the period picker. Capped, because a bank account
 * opened in 2019 would otherwise produce a select with eighty entries in it.
 */
export function recentMonths(upTo: string, earliest: string | null, limit = 24): Period[] {
  const m = ISO.exec(upTo)
  if (!m) return []
  let year = Number(m[1])
  let month = Number(m[2])

  const out: Period[] = []
  while (out.length < limit) {
    const period = monthPeriod(`${year}-${String(month).padStart(2, '0')}-01`)
    if (!period) break
    // Stop once a month ends before the account began being reconciled —
    // offering months whose entries predate the account is offering a
    // reconciliation that can only ever fail.
    if (earliest && period.end < earliest) break
    out.push(period)
    month -= 1
    if (month === 0) { month = 12; year -= 1 }
  }
  return out
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

/**
 * A period in words.
 *
 * A whole calendar month says so ('July 2026'); anything else states both
 * ends, because "July" for a period running 3 July to 2 August would be a
 * label that quietly lies about which transactions are inside it.
 */
export function periodLabel(period: Period): string {
  const s = ISO.exec(period.start)
  const e = ISO.exec(period.end)
  if (!s || !e) return `${period.start} to ${period.end}`

  const wholeMonth =
    s[1] === e[1] && s[2] === e[2] &&
    Number(s[3]) === 1 &&
    period.end === lastDayOfMonthISO(Number(e[1]), Number(e[2]))
  if (wholeMonth) return `${MONTHS[Number(s[2]) - 1]} ${s[1]}`

  const day = (iso: RegExpExecArray) => `${Number(iso[3])} ${MONTHS[Number(iso[2]) - 1].slice(0, 3)}`
  return s[1] === e[1]
    ? `${day(s)} – ${day(e)} ${e[1]}`
    : `${day(s)} ${s[1]} – ${day(e)} ${e[1]}`
}

/** Is this date inside the period? */
export function inPeriod(date: string, period: Period): boolean {
  return date >= period.start && date <= period.end
}
