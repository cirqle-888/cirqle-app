import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The invalidation rules, which are where a cache like this goes wrong.
 *
 * Two failures matter in opposite directions:
 *   · busting too little → a back-dated correction sits invisible for a day
 *   · busting too much   → history is re-read on every ordinary save, the
 *                          cache saves nothing, and somebody rips it out
 *
 * And one rule is not about performance at all: a LOCKED month must not be
 * re-read, because `period_locks` / `profit_snapshots` exist precisely to stop
 * closed books moving.
 */

const revalidateTag = vi.fn()
vi.mock('next/cache', () => ({ revalidateTag: (...a: unknown[]) => revalidateTag(...a) }))
vi.mock('server-only', () => ({}))

// A fixed "today" so these pass at 11pm and at 1am alike.
vi.mock('@/lib/utils/local-date', () => ({ todayISO: () => '2026-09-13' }))

// `monthIsLocked` reaches for the database. The batch tests below care about
// WHICH months are asked about and how often, not about what the answer is.
const finalized = vi.fn(async () => false)
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/payroll/compute', () => ({
  isMonthFinalized: (_c: unknown, m: number, y: number) =>
    finalized(`${y}-${String(m).padStart(2, '0')}` as never),
}))

import {
  invalidateAnalyticsForDate, invalidateAnalyticsForDates,
  invalidateAllAnalytics, currentMonthKey,
} from './invalidate'

beforeEach(() => { revalidateTag.mockClear(); finalized.mockClear() })
afterEach(() => vi.clearAllMocks())

describe('current month is never cached, so never busted', () => {
  it('does nothing for a task dated this month', () => {
    // The common case: an ordinary save. If this busted, every save would
    // discard 36 months of aggregates and the cache would be pointless.
    return invalidateAnalyticsForDate('2026-09-20').then(r => {
      expect(r.busted).toBe(false)
      expect(r.reason).toMatch(/never cached/)
      expect(revalidateTag).not.toHaveBeenCalled()
    })
  })

  it('does nothing for a future-dated task', async () => {
    const r = await invalidateAnalyticsForDate('2026-12-01')
    expect(r.busted).toBe(false)
    expect(revalidateTag).not.toHaveBeenCalled()
  })
})

describe('historical changes bust exactly their own month', () => {
  it('busts the month a back-dated task falls in', async () => {
    const r = await invalidateAnalyticsForDate('2026-03-15')
    expect(r).toMatchObject({ busted: true, month: '2026-03' })
    expect(revalidateTag).toHaveBeenCalledWith('analytics-month-2026-03', 'max')
  })

  it('busts only that month, not the whole window', async () => {
    await invalidateAnalyticsForDate('2026-03-15')
    expect(revalidateTag).toHaveBeenCalledTimes(1)
    expect(revalidateTag).not.toHaveBeenCalledWith('analytics-historical', 'max')
  })

  it('busts an old month just the same', async () => {
    await invalidateAnalyticsForDate('2024-01-05')
    expect(revalidateTag).toHaveBeenCalledWith('analytics-month-2024-01', 'max')
  })
})

describe('a locked month is left alone', () => {
  it('refuses to bust when the month is locked', async () => {
    // Its frozen figures ARE the right answer; re-reading rows would
    // contradict the closed books on purpose.
    const r = await invalidateAnalyticsForDate('2026-03-15', {
      isMonthLocked: async () => true,
    })
    expect(r.busted).toBe(false)
    expect(r.reason).toMatch(/locked/)
    expect(revalidateTag).not.toHaveBeenCalled()
  })

  it('busts when the month is not locked', async () => {
    const r = await invalidateAnalyticsForDate('2026-03-15', {
      isMonthLocked: async () => false,
    })
    expect(r.busted).toBe(true)
  })

  it('busts anyway when the lock state cannot be read', async () => {
    // A needless bust costs one query. A skipped bust on an unlocked month
    // leaves a wrong number on a dashboard.
    const r = await invalidateAnalyticsForDate('2026-03-15', {
      isMonthLocked: async () => { throw new Error('offline') },
    })
    expect(r.busted).toBe(true)
  })
})

describe('bad input', () => {
  it('does nothing, and says so, for an unusable date', async () => {
    for (const d of [null, undefined, '', 'nope']) {
      const r = await invalidateAnalyticsForDate(d)
      expect(r.busted).toBe(false)
      expect(r.month).toBeNull()
    }
    expect(revalidateTag).not.toHaveBeenCalled()
  })
})

describe('the blunt instrument', () => {
  it('clears everything for a bulk change that spans months', async () => {
    await invalidateAllAnalytics()
    expect(revalidateTag).toHaveBeenCalledWith('analytics-historical', 'max')
  })
})

describe('currentMonthKey', () => {
  it('reads the app calendar, not the process clock', () => {
    expect(currentMonthKey()).toBe('2026-09')
  })
})

describe('busting a batch of dates', () => {
  const tags = () => revalidateTag.mock.calls.map(c => c[0])

  it('collapses many rows in one month into ONE bust and ONE lock check', async () => {
    // A bulk edit of 50 rows must not cost 50 `period_locks` reads — the point
    // of the cache is to do LESS database work, not to move where it happens.
    const dates = Array.from({ length: 50 }, (_, i) =>
      `2024-03-${String((i % 28) + 1).padStart(2, '0')}`)
    expect(await invalidateAnalyticsForDates(dates)).toEqual(['2024-03'])
    expect(tags()).toEqual(['analytics-month-2024-03'])
    expect(finalized).toHaveBeenCalledTimes(1)
  })

  it('busts BOTH months when a task moves between them', async () => {
    // Clearing only the new month leaves the old one still counting the task.
    const got = await invalidateAnalyticsForDates(['2024-03-31', '2024-04-01'])
    expect([...got].sort()).toEqual(['2024-03', '2024-04'])
  })

  it('drops the current month and unusable dates without complaining', async () => {
    const thisMonth = `${currentMonthKey()}-05`
    expect(await invalidateAnalyticsForDates([thisMonth, null, undefined, '', 'nonsense']))
      .toEqual([])
    expect(tags()).toEqual([])
    expect(finalized).not.toHaveBeenCalled()
  })

  it('skips a locked month inside a batch but still busts its neighbours', async () => {
    finalized.mockImplementation(async (m: unknown) => m === '2024-03')
    const got = await invalidateAnalyticsForDates(['2024-03-10', '2024-04-10'])
    expect(got).toEqual(['2024-04'])
    finalized.mockImplementation(async () => false)
  })
})
