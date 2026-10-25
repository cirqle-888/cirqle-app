/**
 * Scheduler Utilities
 *
 * Date math for next_run_at computation and comparison-period derivation.
 * Pure functions — no DB access.
 */

import type { ScheduleFrequency, ReportType } from './types'

/**
 * Computes the next UTC run time for a schedule.
 *
 * `deliveryHour` is a wall-clock hour in `timeZone` (an IANA name; the
 * schedule's delivery_timezone column). Each frequency fires on a period
 * boundary, because computeDateRange reports the PREVIOUS complete period:
 *
 *   daily      every day
 *   weekly     Mondays          (reports the previous Mon–Sun)
 *   monthly    the 1st          (reports the previous calendar month)
 *   quarterly  1 Jan/Apr/Jul/Oct
 *   yearly     1 January
 *   custom     every day
 *
 * The result is strictly after `now`. The old version only advanced when
 * today's hour had passed, so a weekly schedule saved on a Monday afternoon
 * got a time in the past (it re-fired on the next cron tick), and a monthly
 * one saved before 07:00 on the 24th fired that morning — mid-month.
 */
export function computeNextRun(
  frequency: ScheduleFrequency,
  deliveryHour: number = 7,
  timeZone: string = 'UTC',
  now: Date = new Date(),
): string {
  if (!Number.isInteger(deliveryHour) || deliveryHour < 0 || deliveryHour > 23) {
    throw new Error(`Invalid delivery hour: ${deliveryHour}`)
  }
  if (!isValidTimeZone(timeZone)) throw new Error(`Invalid time zone: ${timeZone}`)

  const today = zonedDate(now, timeZone)
  // Walk candidate days forward from today; the first boundary day whose
  // delivery instant is after `now` wins. 400 days covers a yearly schedule.
  for (let i = 0; i <= 400; i++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + i))
    if (!isBoundaryDay(frequency, day)) continue
    const at = zonedTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), deliveryHour, timeZone)
    if (at.getTime() > now.getTime()) return at.toISOString()
  }
  throw new Error(`No next run found for ${frequency}`)
}

function isBoundaryDay(frequency: ScheduleFrequency, day: Date): boolean {
  switch (frequency) {
    case 'weekly':    return day.getUTCDay() === 1
    case 'monthly':   return day.getUTCDate() === 1
    case 'quarterly': return day.getUTCDate() === 1 && day.getUTCMonth() % 3 === 0
    case 'yearly':    return day.getUTCDate() === 1 && day.getUTCMonth() === 0
    case 'daily':
    case 'custom':
    default:          return true
  }
}

/** True for a time zone name Intl understands (e.g. 'Asia/Kolkata', 'UTC'). */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || typeof timeZone !== 'string') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/** The calendar day and hour an instant falls on in `timeZone`. */
function zonedParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant)
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value)
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour: get('hour'), minute: get('minute'), second: get('second'),
  }
}

function zonedDate(instant: Date, timeZone: string) {
  const { year, month, day } = zonedParts(instant, timeZone)
  return { year, month, day }
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000
}

/**
 * The UTC instant of a wall-clock hour in `timeZone`. Resolved twice so a
 * DST change between the guess and the answer is accounted for; an hour that
 * does not exist (spring-forward gap) lands just after the gap.
 */
function zonedTimeToUtc(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day, hour)
  let utc = wall - zoneOffsetMs(new Date(wall), timeZone)
  utc = wall - zoneOffsetMs(new Date(utc), timeZone)
  return new Date(utc)
}

/**
 * Derives the date range for a given frequency and reference date.
 * Returns { dateFrom, dateTo } for the CURRENT period.
 */
export function computeDateRange(
  frequency: ScheduleFrequency | ReportType,
  referenceDate: Date = new Date(),
  timeZone: string = 'UTC',
): { dateFrom: string; dateTo: string } {
  // "Today" is the schedule's own calendar day, not the server's UTC day:
  // a 05:00 IST run is still the previous day in UTC.
  const local = zonedDate(referenceDate, isValidTimeZone(timeZone) ? timeZone : 'UTC')
  const ref = new Date(Date.UTC(local.year, local.month - 1, local.day))

  let dateFrom: Date
  let dateTo: Date

  switch (frequency) {
    case 'daily':
      dateFrom = new Date(ref)
      dateFrom.setUTCDate(ref.getUTCDate() - 1)
      dateTo = new Date(dateFrom)
      break

    case 'weekly': {
      // Previous full week: Mon–Sun
      const dow = ref.getUTCDay() || 7 // Mon=1, Sun=7
      dateTo = new Date(ref)
      dateTo.setUTCDate(ref.getUTCDate() - dow) // last Sunday
      dateFrom = new Date(dateTo)
      dateFrom.setUTCDate(dateTo.getUTCDate() - 6) // last Monday
      break
    }

    case 'monthly': {
      // Previous calendar month
      const firstOfMonth = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1))
      dateTo = new Date(firstOfMonth)
      dateTo.setUTCDate(dateTo.getUTCDate() - 1) // last day of prev month
      dateFrom = new Date(Date.UTC(dateTo.getUTCFullYear(), dateTo.getUTCMonth(), 1))
      break
    }

    case 'quarterly': {
      const q = Math.floor(ref.getUTCMonth() / 3)
      const prevQ = (q - 1 + 4) % 4
      const year = prevQ === 3 ? ref.getUTCFullYear() - 1 : ref.getUTCFullYear()
      dateFrom = new Date(Date.UTC(year, prevQ * 3, 1))
      dateTo   = new Date(Date.UTC(year, prevQ * 3 + 3, 0)) // last day of quarter
      break
    }

    case 'yearly': {
      const prevYear = ref.getUTCFullYear() - 1
      dateFrom = new Date(Date.UTC(prevYear, 0, 1))
      dateTo   = new Date(Date.UTC(prevYear, 11, 31))
      break
    }

    default:
      // custom: last 30 days
      dateTo = new Date(ref)
      dateTo.setUTCDate(ref.getUTCDate() - 1)
      dateFrom = new Date(ref)
      dateFrom.setUTCDate(ref.getUTCDate() - 30)
      break
  }

  return {
    dateFrom: toISO(dateFrom),
    dateTo:   toISO(dateTo),
  }
}

/**
 * Returns the comparison period immediately preceding the given range.
 * Same duration, shifted back by the period length.
 */
export function computeComparisonRange(
  dateFrom: string,
  dateTo: string,
): { comparisonFrom: string; comparisonTo: string } {
  const from = new Date(dateFrom)
  const to   = new Date(dateTo)
  const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1

  const compTo   = new Date(from)
  compTo.setUTCDate(compTo.getUTCDate() - 1)
  const compFrom = new Date(compTo)
  compFrom.setUTCDate(compFrom.getUTCDate() - days + 1)

  return {
    comparisonFrom: toISO(compFrom),
    comparisonTo:   toISO(compTo),
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Formats a UTC-midnight calendar Date as YYYY-MM-DD. */
function toISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}
