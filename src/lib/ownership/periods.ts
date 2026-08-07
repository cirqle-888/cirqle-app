/**
 * Period generation — pure date math, no database.
 *
 * Awards are keyed on a DATE RANGE rather than (month, year). That single
 * decision is what lets monthly, quarterly, yearly and one-off programs share
 * one engine and one table: adding a cadence is a case in `periodsFor`, never
 * a schema change.
 *
 * A period books into the payroll of its END month, which is the intuitive
 * reading — a quarter that closes in September is paid with September's
 * salary, not July's.
 */

import type { OwnershipPeriod, OwnershipPeriodType } from './types'

const pad = (n: number) => String(n).padStart(2, '0')
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

/** Last calendar day of a month (handles leap years via day-0 rollback). */
export function endOfMonth(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0))   // day 0 of next month
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

export function monthPeriod(year: number, month: number): OwnershipPeriod {
  return {
    start: `${year}-${pad(month)}-01`,
    end: endOfMonth(year, month),
    bookedMonth: month,
    bookedYear: year,
    label: `${MONTHS[month - 1]} ${year}`,
  }
}

export function quarterPeriod(year: number, quarter: number): OwnershipPeriod {
  const startMonth = (quarter - 1) * 3 + 1
  const endMonth = startMonth + 2
  return {
    start: `${year}-${pad(startMonth)}-01`,
    end: endOfMonth(year, endMonth),
    bookedMonth: endMonth,
    bookedYear: year,
    label: `Q${quarter} ${year}`,
  }
}

export function yearPeriod(year: number): OwnershipPeriod {
  return {
    start: `${year}-01-01`,
    end: `${year}-12-31`,
    bookedMonth: 12,
    bookedYear: year,
    label: String(year),
  }
}

/** Every calendar month a period spans — how a quarterly/yearly profit basis
 *  is summed from the monthly profit engine. */
export function monthsInPeriod(p: OwnershipPeriod): { month: number; year: number }[] {
  const [sy, sm] = p.start.split('-').map(Number)
  const [ey, em] = p.end.split('-').map(Number)
  const out: { month: number; year: number }[] = []
  let y = sy, m = sm
  // Bounded: the guard stops a malformed range from looping forever.
  for (let i = 0; i < 240 && (y < ey || (y === ey && m <= em)); i++) {
    out.push({ month: m, year: y })
    m++
    if (m > 12) { m = 1; y++ }
  }
  return out
}

/**
 * The period a program pays for, given the payroll month being computed.
 *
 * Returns null when the program does not pay in that month at all — a
 * quarterly program produces nothing in months 1 and 2 of its quarter, which
 * is what stops it from paying three times per quarter.
 */
export function periodForBookingMonth(
  periodType: OwnershipPeriodType,
  month: number,
  year: number,
  oneTime?: { start: string | null; end: string | null },
): OwnershipPeriod | null {
  switch (periodType) {
    case 'monthly':
      return monthPeriod(year, month)
    case 'quarterly':
      // Only the closing month of a quarter pays.
      return month % 3 === 0 ? quarterPeriod(year, month / 3) : null
    case 'yearly':
      return month === 12 ? yearPeriod(year) : null
    case 'one_time': {
      if (!oneTime?.start || !oneTime?.end) return null
      const [ey, em] = oneTime.end.split('-').map(Number)
      // A one-off pays once, in the month its window closes.
      if (ey !== year || em !== month) return null
      return {
        start: oneTime.start,
        end: oneTime.end,
        bookedMonth: em,
        bookedYear: ey,
        label: `${oneTime.start} → ${oneTime.end}`,
      }
    }
  }
}

/** Is a date-scoped record live for this period? Judged on the period's END,
 *  so a rule that ended mid-period does not pay for it. */
export function activeForPeriod(
  effectiveFrom: string,
  effectiveTo: string | null,
  period: OwnershipPeriod,
): boolean {
  if (effectiveFrom > period.end) return false
  if (effectiveTo && effectiveTo < period.end) return false
  return true
}
