/**
 * Making the notification bell worth opening.
 *
 * Every row in `notifications` is rendered as its own line, in one flat
 * newest-first list, with one badge counting all of them. That is fine for
 * three notifications a day and useless for thirty: eight separate "New lead
 * from Meta" lines push the one "Payroll draft is ready for review" off the
 * visible part of the panel, and the badge says 31 either way. A badge that
 * is always double digits is a badge people stop reading, which is how the
 * one alert that mattered gets missed.
 *
 * So this module does three things to the rows the bell already fetches —
 * with no schema change, since the table is written by a dozen crons and
 * server actions this pass must not disturb:
 *
 *   · groups repeated events of the same kind into one expandable line;
 *   · separates the ones asking for an action from the ones merely reporting
 *     that something happened, so the badge can count only the former;
 *   · reports how much of the backlog is being ignored rather than read.
 *
 * Snoozing lives in `snooze.ts` — it needs durable storage, this does not.
 *
 * Pure and dependency-free.
 */

import type { NotificationRow } from '@/app/api/notifications/actions'

export type NotificationKind =
  /** Somebody has to do something. Counted by the badge. */
  | 'actionable'
  /** A record of something that already happened. Shown, never counted. */
  | 'informational'

/**
 * Types that report rather than ask.
 *
 * An allow-list rather than a deny-list, and anything unrecognised is treated
 * as ACTIONABLE. That is the safe direction for a feature whose whole purpose
 * is to go quieter: a new notification type added next month shows up in the
 * badge until somebody deliberately decides it is noise, instead of being
 * silently demoted by a default.
 */
const INFORMATIONAL_TYPES: ReadonlySet<string> = new Set([
  'recurring_tasks_generated',
  'recurring_expenses_posted',
  'social_post_published',
  'approval_decided',
  'workspace_reminder',
  'chat_reply',
])

export function notificationKind(type: string): NotificationKind {
  return INFORMATIONAL_TYPES.has(type) ? 'informational' : 'actionable'
}

/**
 * How long apart two events of the same kind can be and still read as "the
 * same thing happening again".
 *
 * A day: eight leads across a morning are one story, and this morning's lead
 * is not the same story as last Tuesday's.
 */
export const GROUP_WINDOW_MS = 24 * 60 * 60 * 1000

/** Unread and older than this counts as ignored rather than pending. */
export const IGNORED_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export interface NotificationGroup {
  /** Stable across refreshes: the group's identity, not a row's. */
  key: string
  kind: NotificationKind
  type: string
  /** The newest row's title — the group shows a count beside it. */
  title: string
  message: string | null
  /** Where it goes. Taken from the newest row that has one. */
  link: string | null
  /** How many rows are folded in. 1 means an ordinary single notification. */
  count: number
  unread: number
  /** ISO timestamp of the newest row. */
  latestAt: string
  /** Newest first. One entry when `count` is 1. */
  rows: NotificationRow[]
}

function ts(iso: string): number {
  const n = new Date(iso).getTime()
  return Number.isFinite(n) ? n : 0
}

/**
 * Fold repeated events together, newest group first.
 *
 * Rows group when they share a type AND a destination and fall inside
 * `GROUP_WINDOW_MS` of the group's newest member. The destination matters:
 * two `invoice_overdue` notifications pointing at two different invoices are
 * two separate jobs, and folding them would hide one of them behind a count.
 * Two pointing at the same invoice are one job mentioned twice.
 *
 * Input order is not trusted — the caller fetches newest-first, but a
 * realtime insert prepends, and a sort here costs nothing on thirty rows.
 */
export function groupNotifications(rows: readonly NotificationRow[]): NotificationGroup[] {
  const sorted = [...rows].sort((a, b) => ts(b.created_at) - ts(a.created_at))
  const groups: NotificationGroup[] = []
  const byKey = new Map<string, NotificationGroup>()

  for (const row of sorted) {
    const bucket = `${row.type}|${row.link ?? ''}`
    const open = byKey.get(bucket)
    // Still the same story? `sorted` is descending, so the open group's
    // newest member is always at or after this row.
    if (open && ts(open.latestAt) - ts(row.created_at) <= GROUP_WINDOW_MS) {
      open.rows.push(row)
      open.count += 1
      if (!row.read) open.unread += 1
      continue
    }
    const group: NotificationGroup = {
      key: `${bucket}|${row.id}`,
      kind: notificationKind(row.type),
      type: row.type,
      title: row.title,
      message: row.message,
      link: row.link,
      count: 1,
      unread: row.read ? 0 : 1,
      latestAt: row.created_at,
      rows: [row],
    }
    groups.push(group)
    byKey.set(bucket, group)
  }

  return groups
}

export interface NotificationMetrics {
  /** Rows considered, after grouping is irrelevant — this counts rows. */
  total: number
  unread: number
  /** Unread rows that ask for an action. What the badge should show. */
  actionableUnread: number
  /** Unread for longer than a week: being ignored, not pending. */
  ignored: number
}

/**
 * What the backlog actually looks like.
 *
 * The plan asks to "measure unread and ignored alerts". Measured and shown to
 * the person it concerns, not collected: a line in the panel saying two
 * alerts have gone a week unread is what changes behaviour, and it keeps the
 * notification contents — which name clients and invoices — out of any
 * analytics pipeline.
 */
export function notificationMetrics(
  rows: readonly NotificationRow[],
  now: number = Date.now(),
): NotificationMetrics {
  let unread = 0
  let actionableUnread = 0
  let ignored = 0
  for (const row of rows) {
    if (row.read) continue
    unread += 1
    if (notificationKind(row.type) === 'actionable') actionableUnread += 1
    if (now - ts(row.created_at) > IGNORED_AFTER_MS) ignored += 1
  }
  return { total: rows.length, unread, actionableUnread, ignored }
}

/** Every row id in a group — for "mark this group read". */
export function groupRowIds(group: NotificationGroup): string[] {
  return group.rows.map(r => r.id)
}
