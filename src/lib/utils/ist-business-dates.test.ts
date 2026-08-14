import { describe, it, expect } from 'vitest'
import { todayISO, toISODate, monthStartISO, monthEndISO, daysFromTodayISO, BUSINESS_TIME_ZONE } from './local-date'
import { getNextOccurrence } from './recurring'
import { formatLocalDate, toSequenceMonth, getInvoiceDateForTaskMonth, buildBillingPeriod } from '@/lib/invoices/numbering'
import { windowForFilter, defaultWindow } from '@/lib/reports/date-bounds'

/**
 * Business dates must follow the India (IST, UTC+5:30) calendar.
 *
 * The zone is declared in code (local-date.ts), not inherited from the
 * machine, so this suite is green under UTC, Asia/Kolkata and America/* alike
 * — and CI runs it under all three. Every case below FAILS if the code
 * serialises a calendar date through `toISOString()`, because UTC is 5.5 hours
 * behind IST:
 *
 *   - between 00:00 and 05:30 IST, the UTC date is still YESTERDAY;
 *   - a Date built from local parts (`new Date(y, m, d)`) is UTC-midnight
 *     minus 5.5h, i.e. the PREVIOUS day, at every hour of every day.
 *
 * True timestamps (created_at, calculated_at) are deliberately NOT covered
 * here — those stay UTC, and `toISOString()` is correct for them.
 */

/**
 * Absolute instants, written with an explicit +05:30 offset so they mean the
 * same moment no matter what clock the test process runs at. That is the whole
 * point: these assertions must hold on a UTC server, an IST laptop and a CI
 * box in any zone.
 */
const ist = (s: string) => new Date(`2026-08-${s}+05:30`)
const MIDNIGHT_IST = ist('15T00:00:00')   // 15 Aug 2026, 00:00 IST
const EARLY_IST    = ist('15T03:30:00')   // 03:30 IST — still 14 Aug in UTC
const LATE_SAFE    = ist('15T23:45:00')   // 23:45 IST — both agree

describe('the business calendar is India, whatever the machine says', () => {
  it('does not depend on the process timezone', () => {
    // No assertion about process.env.TZ on purpose. The zone is declared in
    // code, so this suite is green under UTC, Asia/Kolkata and America/*.
    expect(BUSINESS_TIME_ZONE).toBe('Asia/Kolkata')
  })

  it('proves the UTC route would be wrong here', () => {
    // This is the bug the helpers exist to prevent, asserted so nobody
    // "simplifies" toISODate back into toISOString.
    expect(EARLY_IST.toISOString().slice(0, 10)).toBe('2026-08-14')
    expect(toISODate(EARLY_IST)).toBe('2026-08-15')
  })
})

describe('00:00–05:30 IST — the window where UTC names yesterday', () => {
  it('keeps "today" on the IST day at and after midnight', () => {
    expect(todayISO(MIDNIGHT_IST)).toBe('2026-08-15')
    expect(todayISO(EARLY_IST)).toBe('2026-08-15')
    expect(todayISO(LATE_SAFE)).toBe('2026-08-15')
  })

  it('holds across the whole 00:00–05:29 IST window', () => {
    for (let h = 0; h < 6; h++) {
      for (const m of [0, 29, 59]) {
        if (h === 5 && m > 29) continue
        expect(todayISO(new Date(`2026-08-15T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+05:30`))).toBe('2026-08-15')
      }
    }
  })

  it('rolls to the next day at IST midnight, not 05:30', () => {
    expect(todayISO(ist('14T23:59:59'))).toBe('2026-08-14')
    expect(todayISO(ist('15T00:00:00'))).toBe('2026-08-15')
  })
})

describe('today / yesterday', () => {
  it('separates them correctly just after IST midnight', () => {
    expect(daysFromTodayISO(0, EARLY_IST)).toBe('2026-08-15')
    expect(daysFromTodayISO(-1, EARLY_IST)).toBe('2026-08-14')
  })

  it('does not let "yesterday" collapse onto "today"', () => {
    expect(daysFromTodayISO(0, MIDNIGHT_IST)).not.toBe(daysFromTodayISO(-1, MIDNIGHT_IST))
  })
})

describe('month start / end', () => {
  it('starts the month on the 1st, not the previous month\'s last day', () => {
    // The invoice filter default. Under toISOString() this was 2026-07-31.
    expect(monthStartISO(0, ist('14T02:00:00'))).toBe('2026-08-01')
    expect(monthEndISO(0, ist('14T02:00:00'))).toBe('2026-08-31')
  })

  it('is right at 00:30 IST on the 1st — the worst case', () => {
    // Payroll and month-close read this. A slip here files the day into the
    // PREVIOUS month, which may already be finalized.
    const justAfterMidnightOnThe1st = new Date('2026-09-01T00:30:00+05:30')
    expect(todayISO(justAfterMidnightOnThe1st)).toBe('2026-09-01')
    expect(monthStartISO(0, justAfterMidnightOnThe1st)).toBe('2026-09-01')
  })

  it('handles 30-day, 31-day and leap February', () => {
    expect(monthEndISO(0, new Date('2026-04-10T12:00:00+05:30'))).toBe('2026-04-30')
    expect(monthEndISO(0, new Date('2026-02-10T12:00:00+05:30'))).toBe('2026-02-28')
    expect(monthEndISO(0, new Date('2028-02-10T12:00:00+05:30'))).toBe('2028-02-29')
  })

  it('crosses the year boundary', () => {
    expect(monthStartISO(1, new Date('2026-12-20T12:00:00+05:30'))).toBe('2027-01-01')
    expect(monthEndISO(-1, new Date('2026-01-05T12:00:00+05:30'))).toBe('2025-12-31')
  })
})

describe('invoice dates', () => {
  it('dates the invoice to the 1st of the billing month', () => {
    // getInvoiceDateForTaskMonth builds a Date from local parts and
    // formatLocalDate reads local parts back, so the pair round-trips under any
    // timezone. Asserted here because a `toISOString()` "cleanup" would break
    // it — and it would change the invoice NUMBER, not just the date.
    expect(formatLocalDate(getInvoiceDateForTaskMonth('2026-08'))).toBe('2026-09-01')
    expect(formatLocalDate(getInvoiceDateForTaskMonth('2026-08', { nextMonthBilling: false }))).toBe('2026-08-01')
  })

  it('rolls December into January of the next year', () => {
    expect(formatLocalDate(getInvoiceDateForTaskMonth('2026-12'))).toBe('2027-01-01')
  })

  it('derives the YYMM sequence month from the same local date', () => {
    // A one-day slip here changes the invoice NUMBER, not just its date.
    expect(toSequenceMonth(getInvoiceDateForTaskMonth('2026-08'))).toBe('2609')
    expect(toSequenceMonth(getInvoiceDateForTaskMonth('2026-12'))).toBe('2701')
    expect(toSequenceMonth(getInvoiceDateForTaskMonth('2026-01', { nextMonthBilling: false }))).toBe('2601')
  })

  it('bounds the billing period to the real month end', () => {
    expect(buildBillingPeriod('2026-08')).toMatchObject({
      billing_period_start: '2026-08-01',
      billing_period_end: '2026-08-31',
    })
    expect(buildBillingPeriod('2026-02').billing_period_end).toBe('2026-02-28')
    expect(buildBillingPeriod('2028-02').billing_period_end).toBe('2028-02-29')
    expect(buildBillingPeriod('2026-04').billing_period_end).toBe('2026-04-30')
  })
})

describe('recurring task / cashbook dates', () => {
  it('advances by exactly one interval — never one short', () => {
    // Pure calendar arithmetic: no "now", so the answer must not move with any
    // timezone. The old version parsed LOCAL midnight and serialised via UTC,
    // which returned the day BEFORE each occurrence anywhere east of UTC.
    expect(getNextOccurrence('2026-08-15', 'daily')).toBe('2026-08-16')
    expect(getNextOccurrence('2026-08-15', 'weekly')).toBe('2026-08-22')
    expect(getNextOccurrence('2026-08-15', 'biweekly')).toBe('2026-08-29')
    expect(getNextOccurrence('2026-08-15', 'monthly')).toBe('2026-09-15')
  })

  it('rolls over month and year ends', () => {
    expect(getNextOccurrence('2026-08-31', 'daily')).toBe('2026-09-01')
    expect(getNextOccurrence('2026-12-31', 'daily')).toBe('2027-01-01')
    expect(getNextOccurrence('2026-12-15', 'monthly')).toBe('2027-01-15')
  })

  it('never returns a date on or before the one it was given', () => {
    // The generator loop would spin forever, or re-fire the same day, if it did.
    for (const d of ['2026-01-01', '2026-02-28', '2026-03-01', '2026-08-15', '2026-12-31']) {
      for (const i of ['daily', 'weekly', 'biweekly', 'monthly']) {
        expect(getNextOccurrence(d, i) > d).toBe(true)
      }
    }
  })
})

describe('commission / reporting date ranges', () => {
  const at = (h: number) => ist(`15T${String(h).padStart(2, '0')}:00:00`)

  it('bounds "this month" to real IST month edges', () => {
    expect(windowForFilter({ type: 'thisMonth' }, at(2))).toMatchObject({
      from: '2026-08-01', to: '2026-08-31',
    })
  })

  it('bounds "last month" without bleeding into either neighbour', () => {
    expect(windowForFilter({ type: 'lastMonth' }, at(2))).toMatchObject({
      from: '2026-07-01', to: '2026-07-31',
    })
  })

  it('resolves today/yesterday windows at 02:00 IST', () => {
    expect(windowForFilter({ type: 'today' }, at(2))).toMatchObject({ from: '2026-08-15', to: '2026-08-15' })
    expect(windowForFilter({ type: 'yesterday' }, at(2))).toMatchObject({ from: '2026-08-14', to: '2026-08-14' })
  })

  it('keeps rolling windows inclusive and correctly sized', () => {
    expect(windowForFilter({ type: 'last7' }, at(2))).toMatchObject({ from: '2026-08-09', to: '2026-08-15' })
    expect(windowForFilter({ type: 'last30' }, at(2))).toMatchObject({ from: '2026-07-17', to: '2026-08-15' })
  })

  it('bounds an explicit month, including the leap case', () => {
    expect(windowForFilter({ type: 'month', year: 2028, month: 1 }, at(2))).toMatchObject({
      from: '2028-02-01', to: '2028-02-29',
    })
  })

  it('defaults to a 12-month window anchored on the IST day', () => {
    expect(defaultWindow(at(3))).toMatchObject({ from: '2025-08-15', to: '2026-08-15' })
  })

  it('gives the same window at 00:30 IST as at midday — no midnight cliff', () => {
    // A commission range that changes when someone opens the report at 1am is
    // the exact failure this guards.
    expect(windowForFilter({ type: 'thisMonth' }, at(0))).toEqual(windowForFilter({ type: 'thisMonth' }, at(12)))
    expect(windowForFilter({ type: 'today' }, at(0))).toEqual(windowForFilter({ type: 'today' }, at(12)))
  })
})

describe('true timestamps stay UTC', () => {
  it('leaves toISOString() alone for instants', () => {
    // created_at / calculated_at semantics must NOT change with TZ. An instant
    // is an instant; only calendar dates are localised.
    const t = new Date(Date.UTC(2026, 7, 14, 19, 30, 0))
    expect(t.toISOString()).toBe('2026-08-14T19:30:00.000Z')
    // Same instant, IST calendar day is the 15th — both are correct, for
    // different questions.
    expect(toISODate(t)).toBe('2026-08-15')
  })
})
