import { describe, it, expect } from 'vitest'
import { planPackageCalendar, cadenceLabel, daysBetween, suggestPlacements } from './calendar-coverage'
import type { PlannedItemLike } from './calendar-coverage'
import type { PackageRow, PackageItemRow, PackageTaskLike } from './types'

const POSTER = 'svc-poster'
const REEL = 'svc-reel'

function pkg(over: Partial<PackageRow> = {}): PackageRow {
  return {
    id: 'p1', client_id: 'c1', name: 'Social Media Management',
    billing_type: 'monthly', price: 400, currency: 'AED',
    extra_task_price: 50, start_date: '2026-07-20', end_date: null,
    first_cycle_end: null, status: 'active', notes: null, created_by: null,
    created_at: '', updated_at: '', deleted_at: null, ...over,
  }
}

function item(over: Partial<PackageItemRow> = {}): PackageItemRow {
  return {
    id: 'i1', package_id: 'p1', service_id: POSTER, included_quantity: 15,
    display_order: 0, created_at: '', updated_at: '', ...over,
  }
}

function tasks(n: number, month = '2026-08', fromDay = 1, serviceId = POSTER): PackageTaskLike[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${fromDay + i}`,
    service_id: serviceId,
    task_date: `${month}-${String(fromDay + i).padStart(2, '0')}`,
    task_number: 100 + i,
  }))
}

function planned(n: number, month = '2026-08', fromDay = 20, serviceId = POSTER): PlannedItemLike[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ci${fromDay + i}`,
    service_id: serviceId,
    scheduled_date: `${month}-${String(fromDay + i).padStart(2, '0')}`,
  }))
}

function run(over: {
  packages?: PackageRow[]
  items?: PackageItemRow[]
  tasks?: PackageTaskLike[]
  calendarItems?: PlannedItemLike[]
  month?: string
  today?: string
} = {}) {
  const packages = over.packages ?? [pkg()]
  return planPackageCalendar({
    packages,
    itemsByPackage: new Map(packages.map(p => [p.id, over.items ?? [item({ package_id: p.id })]])),
    tasksByPackage: new Map(packages.map(p => [p.id, over.tasks ?? []])),
    calendarItems: over.calendarItems ?? [],
    month: over.month ?? '2026-08',
    today: over.today ?? '2026-08-13',
  })
}

describe('the three counts stay separate', () => {
  it('splits delivered, planned and unplanned', () => {
    // 15 committed: 4 done, 3 on the calendar, 8 nowhere yet.
    const r = run({ tasks: tasks(4), calendarItems: planned(3) })[0]
    expect(r.delivered).toBe(4)
    expect(r.planned).toBe(3)
    expect(r.remaining).toBe(11)
    expect(r.unplanned).toBe(8)
  })

  it('never counts one piece of work as both planned and delivered', () => {
    // The calendar item was promoted into t1, which is already counted as
    // delivered. Counting it again would read 15/15 handled with 11 still owed.
    const r = run({
      tasks: tasks(4),
      calendarItems: [
        { id: 'ci1', service_id: POSTER, scheduled_date: '2026-08-01', promotedTaskId: 't1' },
        ...planned(2),
      ],
    })[0]
    expect(r.delivered).toBe(4)
    expect(r.planned).toBe(2)
    expect(r.unplanned).toBe(9)
  })

  it('ignores calendar items outside the cycle', () => {
    const r = run({ calendarItems: planned(3, '2026-09', 1) })[0]
    expect(r.planned).toBe(0)
    expect(r.unplanned).toBe(15)
  })

  it('ignores items for a service the package does not include', () => {
    const r = run({ calendarItems: planned(4, '2026-08', 20, REEL) })[0]
    expect(r.planned).toBe(0)
  })

  it('does not let over-planning produce negative unplanned work', () => {
    const r = run({ calendarItems: planned(20, '2026-08', 1) })[0]
    expect(r.planned).toBe(15)
    expect(r.unplanned).toBe(0)
  })

  it('reports each included service on its own', () => {
    const r = run({
      items: [
        item({ id: 'i1', service_id: POSTER, included_quantity: 15, display_order: 0 }),
        item({ id: 'i2', service_id: REEL, included_quantity: 4, display_order: 1 }),
      ],
      tasks: [...tasks(4), ...tasks(1, '2026-08', 25, REEL)],
    })[0]
    expect(r.perService).toHaveLength(2)
    expect(r.perService[0]).toMatchObject({ serviceId: POSTER, included: 15, delivered: 4, remaining: 11 })
    expect(r.perService[1]).toMatchObject({ serviceId: REEL, included: 4, delivered: 1, remaining: 3 })
    expect(r.included).toBe(19)
  })
})

describe('delivered vs merely scheduled', () => {
  it('separates finished work from a task that only exists', () => {
    const r = run({
      tasks: [
        { id: 'a', service_id: POSTER, task_date: '2026-08-01', task_number: 1, status: 'done' },
        { id: 'b', service_id: POSTER, task_date: '2026-08-02', task_number: 2, status: 'pending' },
      ],
    })[0]
    expect(r.delivered).toBe(1)
    expect(r.scheduled).toBe(1)
    // 15 owed, 1 done, 1 in hand → 13 with nothing behind them.
    expect(r.unplanned).toBe(13)
  })

  it('does not ask you to plan work that already has a task', () => {
    const scheduledTasks = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`, service_id: POSTER, task_date: `2026-08-0${i + 1}`,
      task_number: i, status: 'pending',
    }))
    const r = run({ tasks: scheduledTasks })[0]
    expect(r.delivered).toBe(0)
    expect(r.scheduled).toBe(5)
    expect(r.unplanned).toBe(10)
  })

  it('does not count a calendar item AND the unfinished task it became', () => {
    const r = run({
      tasks: [{ id: 't-x', service_id: POSTER, task_date: '2026-08-05', task_number: 1, status: 'pending' }],
      calendarItems: [
        { id: 'ci1', service_id: POSTER, scheduled_date: '2026-08-05', promotedTaskId: 't-x' },
        ...planned(2),
      ],
    })[0]
    expect(r.scheduled).toBe(1)
    expect(r.planned).toBe(2)
    expect(r.unplanned).toBe(12)   // 15 − 1 scheduled − 2 planned
  })

  it('keeps the commitment unmet while work is still unfinished', () => {
    // The visible bug: 2 linked Logo Design tasks, one pending, reading
    // "2 of 2 delivered · Commitment met".
    const r = run({
      items: [item({ included_quantity: 2 })],
      tasks: [
        { id: 'a', service_id: POSTER, task_date: '2026-08-01', task_number: 1, status: 'done' },
        { id: 'b', service_id: POSTER, task_date: '2026-08-02', task_number: 2, status: 'pending' },
      ],
    })[0]
    expect(r.delivered).toBe(1)
    expect(r.remaining).toBe(1)
    expect(r.unplanned).toBe(0)   // nothing to plan — it just needs finishing
  })
})

describe('the cadence needed to finish on time', () => {
  it('paces the work over the days that are actually left', () => {
    // 13 Aug, cycle ends 31 Aug → 19 days for 11 deliverables.
    const r = run({ tasks: tasks(4), today: '2026-08-13' })[0]
    expect(r.daysLeft).toBe(19)
    expect(r.cadence!.everyNDays).toBeCloseTo(19 / 11)
    // NOT "one every 1 days" — 11 across 19 days is 1.7 apart, and rounding
    // that to a daily interval reads as comfortable while finishing short.
    expect(cadenceLabel(r.cadence)).toBe('about 5 a week')
  })

  it('asks for more than one a day when the month has nearly run out', () => {
    const r = run({ tasks: tasks(4), today: '2026-08-28' })[0]
    expect(r.daysLeft).toBe(4)          // 28,29,30,31
    expect(cadenceLabel(r.cadence)).toBe('about 3 a day')
  })

  it('counts today — a cycle ending today still has a day left', () => {
    const r = run({ tasks: tasks(14), today: '2026-08-31' })[0]
    expect(r.daysLeft).toBe(1)
    expect(r.missed).toBe(false)
  })

  it('flags work that has run out of cycle rather than inventing a cadence', () => {
    const r = run({ tasks: tasks(4), today: '2026-09-02' })[0]
    expect(r.daysLeft).toBe(0)
    expect(r.cadence).toBeNull()
    expect(r.missed).toBe(true)
  })

  it('gives no cadence when nothing is owed', () => {
    const r = run({ tasks: tasks(15) })[0]
    expect(r.remaining).toBe(0)
    expect(r.cadence).toBeNull()
    expect(r.missed).toBe(false)
  })

  it('paces from the cycle start when the cycle has not begun', () => {
    const r = run({ month: '2026-09', today: '2026-08-13' })[0]
    expect(r.daysLeft).toBe(30)         // all of September
  })

  it('rounds the interval down, so the schedule finishes the cycle', () => {
    // 10 days, 3 owed → 3.33 days apart. Rounding UP to 4 would schedule the
    // last one after the cycle closed.
    expect(cadenceLabel({ perWeek: 2.1, everyNDays: 10 / 3 })).toBe('one every 3 days')
  })
})

describe('an extended opening cycle', () => {
  const first = [pkg({ first_cycle_end: '2026-08-31' })]

  it('paces across the whole span, not the calendar month', () => {
    // Standing in July, the deadline is 31 Aug — not 31 Jul.
    const r = run({ packages: first, month: '2026-07', today: '2026-07-25' })[0]
    expect(r.deadline).toBe('2026-08-31')
    expect(r.daysLeft).toBe(38)
    expect(r.isFirstCycle).toBe(true)
  })

  it('counts work from both months against the one allowance', () => {
    const both = [...tasks(2, '2026-07', 20), ...tasks(2, '2026-08', 1)]
    const r = run({ packages: first, tasks: both, month: '2026-08', today: '2026-08-13' })[0]
    expect(r.delivered).toBe(4)
    expect(r.remaining).toBe(11)
  })
})

describe('which packages appear at all', () => {
  it('skips a package not in force for the month', () => {
    expect(run({ month: '2026-06' })).toEqual([])
    expect(run({ packages: [pkg({ status: 'paused' })] })).toEqual([])
  })

  it('skips a package that commits to nothing — there is nothing to plan', () => {
    expect(run({ items: [] })).toEqual([])
  })

  it('handles a one-time package, whose cycle is its whole life', () => {
    const once = [pkg({ id: 'p2', billing_type: 'one_time', name: 'Brand Identity', price: 150 })]
    const r = run({ packages: once, items: [item({ package_id: 'p2', included_quantity: 2 })] })[0]
    expect(r.included).toBe(2)
    expect(r.remaining).toBe(2)
  })

  it('gives an open-ended one-time package no deadline and no cadence', () => {
    // The counting span internally runs to the year 9999. Surfacing that would
    // print "31 December" and invent a commitment nobody agreed to.
    const once = [pkg({ id: 'p2', billing_type: 'one_time', end_date: null })]
    const r = run({ packages: once, items: [item({ package_id: 'p2', included_quantity: 2 })] })[0]
    expect(r.deadline).toBeNull()
    expect(r.daysLeft).toBeNull()
    expect(r.cadence).toBeNull()
    expect(r.missed).toBe(false)
    expect(r.windowStart).toBe('2026-07-20')
  })

  it('paces a one-time package that DOES have an end date', () => {
    const once = [pkg({ id: 'p2', billing_type: 'one_time', end_date: '2026-08-31' })]
    const r = run({
      packages: once, items: [item({ package_id: 'p2', included_quantity: 2 })],
      today: '2026-08-13',
    })[0]
    expect(r.deadline).toBe('2026-08-31')
    expect(r.daysLeft).toBe(19)
    expect(r.cadence).not.toBeNull()
  })
})

describe('suggesting where the remaining work should go', () => {
  /** August 2026 as the grid builds it: 42 cells, Sun-first, padding included. */
  function augustGrid(load: Record<string, number> = {}, pkgLoad: Record<string, number> = {}) {
    const cells = []
    // 26 Jul – 5 Sep covers the real grid; only August is inMonth.
    for (let i = 0; i < 42; i++) {
      const d = new Date(Date.UTC(2026, 6, 26 + i))
      const key = d.toISOString().slice(0, 10)
      cells.push({
        key,
        inMonth: key.startsWith('2026-08'),
        load: load[key] ?? 0,
        pkgLoad: pkgLoad[key] ?? 0,
      })
    }
    return cells
  }

  const base = () => run({ tasks: tasks(4), today: '2026-08-13' })[0]

  it('offers exactly as many slots as there is work with nothing behind it', () => {
    const pp = base()
    expect(pp.unplanned).toBe(11)
    expect(suggestPlacements(pp, augustGrid(), '2026-08-13')).toHaveLength(11)
  })

  it('never suggests a day in the past, or a padding cell', () => {
    const out = suggestPlacements(base(), augustGrid(), '2026-08-13')
    for (const p of out) {
      expect(p.date >= '2026-08-13').toBe(true)
      expect(p.date.startsWith('2026-08')).toBe(true)
    }
  })

  it('spreads them out instead of bunching at one end', () => {
    const dates = suggestPlacements(base(), augustGrid(), '2026-08-13').map(p => p.date)
    const uniq = new Set(dates)
    expect(uniq.size).toBeGreaterThan(8)
    expect(dates).toEqual([...dates].sort())        // chronological
  })

  it('suggests nothing once the work is delivered, scheduled or planned', () => {
    const done = run({ tasks: tasks(15), today: '2026-08-13' })[0]
    expect(suggestPlacements(done, augustGrid(), '2026-08-13')).toEqual([])

    const allPlanned = run({ calendarItems: planned(15, '2026-08', 1), today: '2026-08-13' })[0]
    expect(suggestPlacements(allPlanned, augustGrid(), '2026-08-13')).toEqual([])
  })

  it('suggests nothing once the cycle has closed — no future day can help', () => {
    const closed = run({ tasks: tasks(4), today: '2026-09-05' })[0]
    expect(closed.missed).toBe(true)
    expect(suggestPlacements(closed, augustGrid(), '2026-09-05')).toEqual([])
  })

  it('avoids days this package already occupies, when it can', () => {
    // 13-31 Aug is 19 days; 11 needed, so 8 may be blocked before it must
    // fall back. Block the first 6.
    const busy: Record<string, number> = {}
    for (let d = 13; d <= 18; d++) busy[`2026-08-${d}`] = 1
    const out = suggestPlacements(base(), augustGrid(busy, busy), '2026-08-13')
    expect(out.some(p => busy[p.date])).toBe(false)
  })

  it('falls back to crowded days rather than suggesting too few', () => {
    // Every eligible day already has this package's work on it. There is still
    // 11 owed, and silently offering 0 slots would hide that.
    const busy: Record<string, number> = {}
    for (let d = 1; d <= 31; d++) busy[`2026-08-${String(d).padStart(2, '0')}`] = 1
    expect(suggestPlacements(base(), augustGrid(busy, busy), '2026-08-13')).toHaveLength(11)
  })

  it('prefers a quiet day to a crowded one when both are free of this package', () => {
    const load: Record<string, number> = {}
    for (let d = 13; d <= 31; d++) load[`2026-08-${d}`] = 3
    load['2026-08-20'] = 0
    const out = suggestPlacements(base(), augustGrid(load), '2026-08-13')
    expect(out.map(p => p.date)).toContain('2026-08-20')
  })

  it('shares the slots between services in proportion to what each still needs', () => {
    const two = run({
      items: [
        item({ id: 'i1', service_id: POSTER, included_quantity: 10, display_order: 0 }),
        item({ id: 'i2', service_id: REEL, included_quantity: 2, display_order: 1 }),
      ],
      today: '2026-08-13',
    })[0]
    const out = suggestPlacements(two, augustGrid(), '2026-08-13')
    expect(out).toHaveLength(12)
    expect(out.filter(p => p.serviceId === POSTER)).toHaveLength(10)
    expect(out.filter(p => p.serviceId === REEL)).toHaveLength(2)
    // Interleaved, not ten posters then two reels.
    const firstReel = out.findIndex(p => p.serviceId === REEL)
    expect(firstReel).toBeLessThan(6)
  })

  it('is deterministic — the same month never reshuffles between renders', () => {
    const a = suggestPlacements(base(), augustGrid(), '2026-08-13')
    const b = suggestPlacements(base(), augustGrid(), '2026-08-13')
    expect(a).toEqual(b)
  })

  it('offers every remaining day when the work outnumbers the days left', () => {
    const late = run({ tasks: tasks(4), today: '2026-08-29' })[0]
    const out = suggestPlacements(late, augustGrid(), '2026-08-29')
    expect(out).toHaveLength(11)
    // 29, 30, 31 — three days for eleven, so days legitimately repeat.
    expect(new Set(out.map(p => p.date))).toEqual(new Set(['2026-08-29', '2026-08-30', '2026-08-31']))
  })

  it('does not suggest past the deadline when the cycle ends mid-grid', () => {
    // First cycle to 31 Aug, viewed in July: the July grid's eligible days are
    // July's only, because inMonth clamps to the plan's own month.
    const first = run({
      packages: [pkg({ first_cycle_end: '2026-08-31' })],
      month: '2026-07', today: '2026-07-25',
    })[0]
    const julyGrid = augustGrid().map(c => ({ ...c, inMonth: c.key.startsWith('2026-07') }))
    const out = suggestPlacements(first, julyGrid, '2026-07-25')
    for (const p of out) expect(p.date.startsWith('2026-07')).toBe(true)
  })
})

describe('pace — where a steady schedule says the cycle should be', () => {
  it('reports how far delivered work trails the steady pace', () => {
    // Plain August cycle, 15 owed. By the 16th, 16/31 of the month has passed
    // → ~8 expected; 4 done → 4 behind.
    const r = run({ tasks: tasks(4), today: '2026-08-16' })[0]
    expect(r.expectedByToday).toBe(8)
    expect(r.behind).toBe(4)
    expect(r.pace).toBe('behind')
  })

  it('calls it on pace when delivery matches the schedule', () => {
    const r = run({ tasks: tasks(8), today: '2026-08-16' })[0]
    expect(r.pace).toBe('on_track')
    expect(r.behind).toBe(0)
  })

  it('calls it ahead when delivery beats the schedule', () => {
    expect(run({ tasks: tasks(12), today: '2026-08-16' })[0].pace).toBe('ahead')
  })

  it('does not let unfinished tasks count toward keeping pace', () => {
    // 4 done + 4 pending on the 16th: the plan exists, the catch-up hasn't
    // happened. Pace is measured on finished work only.
    const r = run({
      tasks: [
        ...tasks(4),
        ...Array.from({ length: 4 }, (_, i) => ({
          id: `p${i}`, service_id: POSTER, task_date: `2026-08-1${i}`,
          task_number: 50 + i, status: 'pending',
        })),
      ],
      today: '2026-08-16',
    })[0]
    expect(r.pace).toBe('behind')
    expect(r.behind).toBe(4)
  })

  it('has no pace verdict without a deadline to pace against', () => {
    const once = [pkg({ id: 'p2', billing_type: 'one_time', end_date: null })]
    const r = run({ packages: once, items: [item({ package_id: 'p2', included_quantity: 2 })] })[0]
    expect(r.pace).toBeNull()
    expect(r.behind).toBe(0)
  })
})

describe('catch-up slots land soonest', () => {
  function grid(monthPrefix = '2026-08') {
    const cells = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(Date.UTC(2026, 6, 26 + i))
      const key = d.toISOString().slice(0, 10)
      cells.push({ key, inMonth: key.startsWith(monthPrefix), load: 0, pkgLoad: 0 })
    }
    return cells
  }

  it('front-loads the shortfall instead of spreading it to month-end', () => {
    // 4 behind on the 16th: the first four slots hug the next four days.
    const pp = run({ tasks: tasks(4), today: '2026-08-16' })[0]
    const out = suggestPlacements(pp, grid(), '2026-08-16')
    const catchUps = out.filter(p => p.catchUp)
    expect(catchUps).toHaveLength(4)
    expect(catchUps.map(p => p.date)).toEqual(
      ['2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19'],
    )
    // The rest still spread across the remaining days.
    const rest = out.filter(p => !p.catchUp)
    expect(rest[rest.length - 1].date > '2026-08-25').toBe(true)
  })

  it('lets work already in hand absorb the shortfall first', () => {
    // 4 behind, but 2 posts are already planned on the calendar — only the
    // uncovered 2 need front-loading.
    const pp = run({
      tasks: tasks(4), today: '2026-08-16',
      calendarItems: planned(2, '2026-08', 20),
    })[0]
    const out = suggestPlacements(pp, grid(), '2026-08-16')
    expect(out.filter(p => p.catchUp)).toHaveLength(2)
  })

  it('marks nothing catch-up when the cycle is on pace', () => {
    const pp = run({ tasks: tasks(8), today: '2026-08-16' })[0]
    const out = suggestPlacements(pp, grid(), '2026-08-16')
    expect(out.some(p => p.catchUp)).toBe(false)
    expect(out.length).toBe(7)
  })
})

describe('daysBetween', () => {
  it('counts both ends', () => {
    expect(daysBetween('2026-08-01', '2026-08-01')).toBe(1)
    expect(daysBetween('2026-08-01', '2026-08-31')).toBe(31)
  })

  it('crosses a month boundary', () => {
    expect(daysBetween('2026-07-20', '2026-08-31')).toBe(43)
  })

  it('goes negative once the end is in the past', () => {
    expect(daysBetween('2026-09-02', '2026-08-31')).toBeLessThan(0)
  })
})
