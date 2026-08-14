/**
 * Scheduler Utilities
 *
 * Date math for next_run_at computation and comparison-period derivation.
 * Pure functions — no DB access.
 */

import type { ScheduleFrequency, ReportType } from './types'
import { toISODate } from '@/lib/utils/local-date'

/**
 * Computes the next UTC run time for a given frequency and delivery hour.
 * Always returns a time in the future.
 */
export function computeNextRun(frequency: ScheduleFrequency, deliveryHour: number = 7): string {
  const now = new Date()
  const next = new Date(now)

  // Set to today at delivery hour
  next.setUTCHours(deliveryHour, 0, 0, 0)

  // If we've already passed today's window, advance to next occurrence
  if (next <= now) {
    switch (frequency) {
      case 'daily':
        next.setUTCDate(next.getUTCDate() + 1)
        break
      case 'weekly':
        next.setUTCDate(next.getUTCDate() + (7 - next.getUTCDay() + 1) % 7 || 7) // next Monday
        break
      case 'monthly':
        next.setUTCMonth(next.getUTCMonth() + 1, 1) // 1st of next month
        break
      case 'quarterly':
        next.setUTCMonth(next.getUTCMonth() + 3, 1)
        break
      case 'yearly':
        next.setUTCFullYear(next.getUTCFullYear() + 1, 0, 1)
        break
      case 'custom':
        next.setUTCDate(next.getUTCDate() + 1) // default: next day
        break
    }
  }

  return next.toISOString()
}

/**
 * Derives the date range for a given frequency and reference date.
 * Returns { dateFrom, dateTo } for the CURRENT period.
 */
export function computeDateRange(
  frequency: ScheduleFrequency | ReportType,
  referenceDate: Date = new Date(),
): { dateFrom: string; dateTo: string } {
  const ref = new Date(referenceDate)
  ref.setUTCHours(0, 0, 0, 0)

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

function toISO(d: Date): string {
  return toISODate(d)
}
