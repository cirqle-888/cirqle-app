/**
 * Which plan needs attention — the logic behind two things on the Social
 * Calendar: the plan it opens on, and the "needs attention" strip that stays
 * on screen whichever plan is open.
 *
 * Pure on purpose: the server uses it to choose the plan, the browser uses it
 * to draw the strip and the month summary, and both must agree on what "late"
 * means.
 */

import {
  resolveItemProgress, isUnrouted,
  type ItemProgress, type LinkedRequestView, type RoutableItem,
} from './plan'

// ── Where one item stands ────────────────────────────────────────────────────
// The pipeline has six states, which is right for the Board but too many to
// read off a month at a glance. They fold into the four things a planner asks:
// is it done, is someone on it, is it still to come, and has its day passed
// without it being finished.
export type Bucket = 'done' | 'active' | 'planned' | 'late'

export function itemBucket(
  progress: ItemProgress,
  it: { scheduled_date: string | null; scheduled_end_date?: string | null },
  today: string,
): Bucket | null {
  if (progress === 'cancelled') return null
  // Delivered counts as done, as it does for the monthly report: the client
  // has the work, whatever their review still says.
  if (progress === 'done' || progress === 'delivered') return 'done'
  const start = it.scheduled_date
  // A campaign is late only once its LAST day has gone.
  const due = it.scheduled_end_date && start && it.scheduled_end_date > start ? it.scheduled_end_date : start
  if (due && due < today) return 'late'
  return progress === 'planned' ? 'planned' : 'active'
}

// ── A whole plan in six numbers ──────────────────────────────────────────────

export interface PlanTally {
  /** Dated items, cancelled ones left out. Undated ideas are not counted. */
  total: number
  done: number
  /** Sent on (in Requests or with a designer), date not yet passed. */
  active: number
  /** On the calendar, not sent, date not yet passed. */
  planned: number
  /** Date passed, not finished. */
  late: number
  /** Dated items nothing holds yet — late ones included. */
  toSend: number
}

export const EMPTY_TALLY: PlanTally = { total: 0, done: 0, active: 0, planned: 0, late: 0, toSend: 0 }

/** The item fields a tally reads. Structural, so any projection of the row fits. */
export interface FocusItem extends RoutableItem {
  scheduled_date: string | null
  scheduled_end_date?: string | null
  request?: (LinkedRequestView & { promoted_task_id?: string | null }) | null
}

export function tallyPlan(items: FocusItem[], today: string): PlanTally {
  const t: PlanTally = { ...EMPTY_TALLY }
  for (const it of items) {
    if (!it.scheduled_date) continue
    const bucket = itemBucket(resolveItemProgress(it.status, it.request, it.task), it, today)
    if (!bucket) continue
    t.total++
    t[bucket]++
    if (isUnrouted(it)) t.toSend++
  }
  return t
}

/** Items on the plan that are not finished. */
export const openCount = (t: PlanTally) => t.total - t.done

/**
 * How loudly a plan is asking for attention. Late work outranks everything —
 * one late post beats any amount of unsent work — and work nobody has been
 * given yet outranks work already with someone.
 */
export const urgency = (t: PlanTally) => t.late * 10_000 + t.toSend * 100 + t.active

// ── Months as 'YYYY-MM' ──────────────────────────────────────────────────────

export function shiftMonthKey(key: string, by: number): string {
  const [y, m] = key.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + by, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

// ── Which plan to open ───────────────────────────────────────────────────────

export interface FocusPlan {
  id: string
  /** 'YYYY-MM-01' */
  month: string
  status: 'draft' | 'active' | 'archived'
  clientName: string
}

/**
 * The plan the Social Calendar opens on when the link names none.
 *
 * 1. The plan this person last opened — unless it has gone stale: archived,
 *    deleted, or a past month with nothing left open. A finished month should
 *    not keep hold of the front page.
 * 2. Otherwise the plan that most needs attention: this month's plans first,
 *    most urgent on top; with none this month, the nearest month ahead; with
 *    none ahead either, the most recent past month.
 *
 * `tallies` may be missing a plan (only the months around today are tallied);
 * a plan with no tally is treated as having nothing open.
 */
export function pickDefaultPlan({ plans, tallies, lastOpenedId, thisMonth }: {
  plans: FocusPlan[]
  tallies: Record<string, PlanTally>
  lastOpenedId: string | null
  /** 'YYYY-MM' */
  thisMonth: string
}): string | null {
  const live = plans.filter(p => p.status !== 'archived')
  const tallyOf = (p: FocusPlan) => tallies[p.id] ?? EMPTY_TALLY
  const key = (p: FocusPlan) => p.month.slice(0, 7)

  const last = lastOpenedId ? live.find(p => p.id === lastOpenedId) : undefined
  if (last && (key(last) >= thisMonth || openCount(tallyOf(last)) > 0)) return last.id

  const mostUrgent = (list: FocusPlan[]) => [...list].sort((a, b) =>
    urgency(tallyOf(b)) - urgency(tallyOf(a))
    || openCount(tallyOf(b)) - openCount(tallyOf(a))
    || tallyOf(b).total - tallyOf(a).total
    || a.clientName.localeCompare(b.clientName))[0]

  const now = live.filter(p => key(p) === thisMonth)
  if (now.length) return mostUrgent(now).id

  const ahead = live.filter(p => key(p) > thisMonth)
  if (ahead.length) {
    const soonest = ahead.map(key).sort()[0]
    return mostUrgent(ahead.filter(p => key(p) === soonest)).id
  }

  const behind = live.filter(p => key(p) < thisMonth)
  if (behind.length) {
    const latest = behind.map(key).sort().reverse()[0]
    return mostUrgent(behind.filter(p => key(p) === latest)).id
  }

  // Only archived plans exist — open the newest rather than an empty page.
  return [...plans].sort((a, b) => b.month.localeCompare(a.month))[0]?.id ?? null
}
