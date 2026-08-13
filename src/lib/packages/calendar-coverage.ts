/**
 * What a package still needs from the content calendar.
 *
 * The Packages page answers "how much have we delivered?". A planner needs the
 * next question: *what is still owed, is it on the calendar, and how often must
 * we post to finish the cycle on time?*
 *
 * Three counts, deliberately kept apart — collapsing them is what makes a
 * retainer quietly run out of month:
 *
 *   delivered  real tasks linked to the package inside this cycle. Work done.
 *   planned    calendar items scheduled inside the cycle that have NOT yet
 *              become one of those tasks. Intent, not delivery.
 *   unplanned  what is still owed and is not even on the calendar. This is the
 *              number that costs money, and nothing else on screen shows it.
 *
 * Pure — no database, no clock. `today` is a parameter so the answer is
 * reproducible and testable.
 */

import { cycleForMonth, resolveCoverageForPackage, isPackageInForceForMonth } from './progress'
import type { PackageRow, PackageItemRow, PackageTaskLike } from './types'

/** The calendar-item fields this reads. Nothing else is needed. */
export interface PlannedItemLike {
  id: string
  service_id?: string | null
  scheduled_date?: string | null
  /**
   * The task this item became, once promoted through a request. Used to avoid
   * counting one piece of work as both planned AND delivered.
   */
  promotedTaskId?: string | null
}

/**
 * One included line, split four ways.
 *
 * delivered + scheduled + planned + unplanned ≈ included. The four are kept
 * apart because they need different actions: nothing, wait, produce, and
 * *decide when* — and only the last one is invisible everywhere else.
 */
export interface ServiceCommitment {
  serviceId: string
  included: number
  /** Finished. */
  delivered: number
  /** A task exists but isn't done yet. */
  scheduled: number
  /** On the calendar, not yet a task. */
  planned: number
  /** Still owed: included − delivered. Never negative. */
  remaining: number
  /** Owed with nothing at all behind it yet. Never negative. */
  unplanned: number
}

/** How often work must land to finish the cycle on time. */
export interface Cadence {
  /** Deliverables per week for the rest of the cycle. */
  perWeek: number
  /** Days between deliverables. */
  everyNDays: number
}

export interface CalendarPackageProgress {
  packageId: string
  name: string
  currency: string
  price: number
  billingType: PackageRow['billing_type']
  /** Start of the span on screen. For one-time work, the package's own start. */
  windowStart: string
  /**
   * The date the outstanding work is due.
   *
   * NULL for an open-ended one-time package: its allowance has no reset and no
   * expiry, so there is no deadline to pace against. Showing one — the cycle's
   * internal upper bound is the year 9999 — would print "31 December" and read
   * as a real commitment.
   */
  deadline: string | null
  isFirstCycle: boolean
  perService: ServiceCommitment[]
  included: number
  delivered: number
  scheduled: number
  planned: number
  remaining: number
  unplanned: number
  /**
   * Days left before `deadline`, counting today. 0 once it has passed.
   * null when there is no deadline.
   */
  daysLeft: number | null
  /** null when nothing is owed, or there is no deadline, or it has passed. */
  cadence: Cadence | null
  /** Owed work with no days left to do it in. */
  missed: boolean
  /**
   * Where the cycle SHOULD be by today, at a steady pace: included × elapsed
   * share of the cycle. 0 when the cycle has no deadline to pace against.
   */
  expectedByToday: number
  /**
   * How far the finished work trails that steady pace. Deliberately counts
   * only DELIVERED work — a task merely created, or a post merely on the
   * calendar, hasn't caught anything up yet.
   */
  behind: number
  /** null when there is no deadline to pace against. */
  pace: 'ahead' | 'on_track' | 'behind' | null
}

const DAY_MS = 86_400_000

/** Whole days from `a` to `b`, inclusive of both. Negative when b precedes a. */
export function daysBetween(a: string, b: string): number {
  const t1 = Date.parse(`${a}T00:00:00Z`)
  const t2 = Date.parse(`${b}T00:00:00Z`)
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return 0
  return Math.round((t2 - t1) / DAY_MS) + 1
}

export interface CalendarCoverageInput {
  /** Every non-deleted package for the calendar's client. */
  packages: PackageRow[]
  itemsByPackage: Map<string, PackageItemRow[]>
  /** package_id → its linked tasks (all of them; the cycle is applied here). */
  tasksByPackage: Map<string, PackageTaskLike[]>
  /** The calendar's month, `YYYY-MM`. */
  month: string
  /** Every item on the calendar being viewed. */
  calendarItems: PlannedItemLike[]
  /** `YYYY-MM-DD`. Passed in so this stays pure. */
  today: string
}

/**
 * What each package in force for this month still needs.
 *
 * Returns one entry per package that both applies to the month and commits to
 * something; a package with no included lines is dropped, since there is
 * nothing to plan against.
 */
export function planPackageCalendar(input: CalendarCoverageInput): CalendarPackageProgress[] {
  const out: CalendarPackageProgress[] = []

  for (const pkg of input.packages) {
    if (!isPackageInForceForMonth(pkg, input.month)) continue

    const items = input.itemsByPackage.get(pkg.id) ?? []
    if (items.length === 0) continue

    const tasks = input.tasksByPackage.get(pkg.id) ?? []
    const cycle = cycleForMonth(pkg, input.month)
    const cov = resolveCoverageForPackage(pkg, tasks, items, input.month)

    // Tasks the package already counts, finished or not. A calendar item that
    // became one of these is delivered or scheduled — never "planned" as well.
    // Counting it twice would show a cycle as fully handled while half of it is
    // still to do.
    const deliveredTaskIds = new Set([
      ...cov.coveredTaskIds, ...cov.extraTaskIds, ...cov.scheduledTaskIds,
    ])

    // service_id → how many items sit in the cycle awaiting delivery.
    const plannedByService = new Map<string, number>()
    for (const it of input.calendarItems) {
      const d = String(it.scheduled_date ?? '')
      if (!d || d < cycle.start || d > cycle.end) continue
      if (it.promotedTaskId && deliveredTaskIds.has(it.promotedTaskId)) continue
      if (!it.service_id) continue
      plannedByService.set(it.service_id, (plannedByService.get(it.service_id) ?? 0) + 1)
    }

    const perService: ServiceCommitment[] = cov.perItem.map(p => {
      const remaining = Math.max(0, p.included - p.delivered)
      // An unfinished task already accounts for part of what's owed — it needs
      // finishing, not scheduling.
      const scheduled = Math.min(remaining, p.scheduled)
      // Planning more than is owed is not an error — it is next month's work,
      // or deliberate overage. Cap it so `unplanned` cannot go negative.
      const planned = Math.min(remaining - scheduled, plannedByService.get(p.serviceId) ?? 0)
      return {
        serviceId: p.serviceId,
        included: p.included,
        delivered: p.delivered,
        scheduled,
        planned,
        remaining,
        unplanned: Math.max(0, remaining - scheduled - planned),
      }
    })

    const sum = (k: keyof ServiceCommitment) =>
      perService.reduce((s, p) => s + (p[k] as number), 0)

    const remaining = sum('remaining')

    // A monthly cycle is bounded by the month (or the opening span); a one-time
    // package is bounded only by its own end date, if it has one.
    const oneTime = pkg.billing_type === 'one_time'
    const windowStart = oneTime ? pkg.start_date : cycle.start
    const deadline = oneTime ? (pkg.end_date ?? null) : cycle.end

    // Counting today: work can still land today, so a deadline of today leaves
    // one day, not none.
    const daysLeft = deadline === null
      ? null
      : Math.max(0, daysBetween(maxDate(input.today, windowStart), deadline))

    // Steady-pace expectation: by day N of a T-day cycle, N/T of the work.
    // Only DELIVERED work counts toward keeping pace — a task that exists but
    // isn't finished, or a post that is merely on the calendar, is a plan for
    // catching up, not the catch-up itself.
    const included = sum('included')
    let expectedByToday = 0
    let pace: CalendarPackageProgress['pace'] = null
    if (deadline !== null && included > 0) {
      const total = Math.max(1, daysBetween(windowStart, deadline))
      const elapsed = Math.min(total, Math.max(0, daysBetween(windowStart, input.today)))
      expectedByToday = Math.min(included, Math.round((included * elapsed) / total))
      const delivered = sum('delivered')
      pace = delivered >= expectedByToday
        ? (delivered > expectedByToday ? 'ahead' : 'on_track')
        : 'behind'
    }
    const behind = Math.max(0, expectedByToday - sum('delivered'))

    out.push({
      packageId: pkg.id,
      name: pkg.name,
      currency: pkg.currency,
      price: Number(pkg.price) || 0,
      billingType: pkg.billing_type,
      windowStart,
      deadline,
      isFirstCycle: cycle.isFirstCycle,
      perService,
      included: sum('included'),
      delivered: sum('delivered'),
      scheduled: sum('scheduled'),
      planned: sum('planned'),
      remaining,
      unplanned: sum('unplanned'),
      daysLeft,
      cadence: remaining > 0 && daysLeft !== null && daysLeft > 0
        ? { perWeek: (remaining / daysLeft) * 7, everyNDays: daysLeft / remaining }
        : null,
      missed: remaining > 0 && daysLeft === 0,
      expectedByToday,
      behind,
      pace,
    })
  }

  return out
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b
}

/** One grid cell, as the calendar already models it. */
export interface PlacementDay {
  /** `YYYY-MM-DD`. */
  key: string
  /** False for the leading/trailing padding cells of the month grid. */
  inMonth: boolean
  /** Everything already on this day — used to leave crowded days alone. */
  load: number
  /** Items on this day for a service THIS package includes. */
  pkgLoad: number
}

/** A suggested slot: a date, and which included service it would satisfy. */
export interface Placement {
  date: string
  serviceId: string
  packageId: string
  /**
   * True when this slot exists to recover a pace shortfall — work the steady
   * schedule says should already be done. Catch-up slots land in the nearest
   * days rather than being spread out; the UI may say so, gently.
   */
  catchUp: boolean
}

/**
 * Where the outstanding deliverables could go.
 *
 * A suggestion, not a booking — nothing is written until a human types a title.
 * That restraint is the point: auto-creating placeholder items would count
 * toward `planned` and drive `unplanned` to zero, so the feature would erase
 * the very number it exists to expose.
 *
 * Pure: every input is a parameter, every sort is total, so the same month
 * always produces the same slots and they don't shuffle between renders.
 */
export function suggestPlacements(
  pp: CalendarPackageProgress,
  days: PlacementDay[],
  today: string,
): Placement[] {
  const k = pp.unplanned
  // Nothing owed that isn't already a task or already on the calendar; or the
  // cycle has closed and no future day can help.
  if (k <= 0 || pp.missed) return []

  // Only real days of the month on screen: the server rejects an item dated
  // outside its plan's month, and a package cycle can span two months.
  const from = maxDate(today, pp.windowStart)
  const to = pp.deadline ?? '9999-12-31'
  const eligible = days.filter(d => d.inMonth && d.key >= from && d.key <= to)
  if (eligible.length === 0) return []

  // Prefer days where this package has nothing yet. A day already holding a
  // Reel is still a fine day for a Poster, so this looks at pkgLoad, not load.
  const clean = eligible.filter(d => d.pkgLoad === 0)
  const pool = clean.length >= k ? clean : eligible
  const n = pool.length

  // How many of the k slots are CATCH-UP — work a steady pace says should
  // already be done. Unfinished tasks and calendar items absorb the shortfall
  // first (they are the catch-up already in hand), so only the uncovered rest
  // needs front-loading here.
  const catchUp = Math.min(k, Math.max(0, pp.behind - pp.scheduled - pp.planned))

  // Catch-up slots go one-per-day into the NEAREST days: spreading them out
  // would schedule the recovery of last week's shortfall for the end of the
  // month. The remaining slots spread evenly across what's left, centred (+0.5
  // keeps the run off both ends when there is room; when k approaches n every
  // day is used, which is correct — 11 owed across 12 days IS every day).
  const idx: number[] = []
  for (let i = 0; i < catchUp; i++) {
    idx.push(Math.min(n - 1, i))
  }
  const restStart = catchUp < n ? catchUp : n - 1
  const restSpan = n - restStart
  for (let i = 0; i < k - catchUp; i++) {
    idx.push(restStart + Math.min(restSpan - 1, Math.max(0, Math.floor(((i + 0.5) * restSpan) / (k - catchUp)))))
  }

  // Nudge off crowded days into adjacent slack, without ever crossing a
  // neighbour. This is what stops a hint from growing a whole grid row.
  for (let i = 0; i < idx.length; i++) {
    if (pool[idx[i]].load < 2) continue
    for (const off of [1, -1, 2, -2]) {
      const j = idx[i] + off
      if (j < 0 || j >= n) continue
      if (i > 0 && j <= idx[i - 1]) continue
      if (i < idx.length - 1 && j >= idx[i + 1]) continue
      if (pool[j].load < pool[idx[i]].load) { idx[i] = j; break }
    }
  }

  // Interleave the services rather than emitting all of one then all of the
  // other, so a 10-poster / 2-reel month reads as a real schedule.
  const labels = interleaveServices(pp, k)

  return idx.map((j, i) => ({
    date: pool[j].key,
    serviceId: labels[i],
    packageId: pp.packageId,
    catchUp: i < catchUp,
  }))
}

/** `k` service ids, shared out in proportion to what each one still needs. */
function interleaveServices(pp: CalendarPackageProgress, k: number): string[] {
  const owed = pp.perService
    .filter(s => s.unplanned > 0)
    .sort((a, b) => b.unplanned - a.unplanned || a.serviceId.localeCompare(b.serviceId))
  if (owed.length === 0) return Array.from({ length: k }, () => pp.perService[0]?.serviceId ?? '')
  if (owed.length === 1) return Array.from({ length: k }, () => owed[0].serviceId)

  // D'Hondt, not "whichever has most left".
  //
  // Draining the largest remainder first emits ten posters and only then two
  // reels — technically the right totals, but it reads as two separate lists
  // rather than a schedule. Picking the highest quota/(emitted+1) instead
  // spreads the smaller service through the run: P P P P P R P P P P P R.
  const quota = owed.map(s => s.unplanned)
  const emitted = owed.map(() => 0)
  const out: string[] = []
  for (let i = 0; i < k; i++) {
    let best = 0
    let bestScore = quota[0] / (emitted[0] + 1)
    for (let j = 1; j < owed.length; j++) {
      const score = quota[j] / (emitted[j] + 1)
      // Strict >, so ties fall to the earlier service — which `owed` has
      // already sorted deterministically.
      if (score > bestScore) { best = j; bestScore = score }
    }
    out.push(owed[best].serviceId)
    emitted[best] += 1
  }
  return out
}

/**
 * The cadence as a sentence.
 *
 * Three registers, because one unit cannot carry the whole range. "One every 1
 * days" for 13 posts across 19 days is technically a rounding of 1.46 and
 * practically a lie — it schedules 19 and reads as comfortable. A weekly rate
 * says "about 5 a week", which is both true and actionable.
 *
 * Everything rounds UP (or the interval DOWN) so the pace errs toward posting
 * sooner; the opposite would read as on track and finish the cycle short.
 */
export function cadenceLabel(cadence: Cadence | null): string | null {
  if (!cadence) return null
  if (cadence.perWeek >= 7) {
    return `about ${Math.ceil(cadence.perWeek / 7)} a day`
  }
  // Below ~3 a week the interval is the more natural unit: "one every 5 days"
  // beats "about 2 a week", and rounding a small weekly figure up distorts it.
  if (cadence.perWeek >= 3) {
    return `about ${Math.ceil(cadence.perWeek)} a week`
  }
  const every = Math.max(1, Math.floor(cadence.everyNDays))
  return every === 1 ? 'one every day' : `one every ${every} days`
}
