import { describe, it, expect } from 'vitest'
import {
  notificationKind, groupNotifications, notificationMetrics, groupRowIds,
  GROUP_WINDOW_MS, IGNORED_AFTER_MS,
} from './digest'
import {
  pruneSnoozes, isSnoozed, withSnooze, withoutSnooze, SNOOZE_OPTIONS,
} from './snooze'
import type { NotificationRow } from '@/app/api/notifications/actions'

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0)
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

let seq = 0
const row = (over: Partial<NotificationRow> = {}): NotificationRow => ({
  id: `n${++seq}`,
  employee_id: 'emp-1',
  type: 'meta_lead_received',
  title: 'New lead from Meta',
  message: null,
  link: '/dashboard/leads',
  read: false,
  created_at: iso(0),
  ...over,
})

describe('actionable vs informational', () => {
  it('counts anything asking for work', () => {
    expect(notificationKind('invoice_overdue')).toBe('actionable')
    expect(notificationKind('payroll_draft_created')).toBe('actionable')
    expect(notificationKind('chat_mention')).toBe('actionable')
  })

  it('does not count a report of something already done', () => {
    expect(notificationKind('recurring_tasks_generated')).toBe('informational')
    expect(notificationKind('social_post_published')).toBe('informational')
  })

  it('treats an unknown type as actionable', () => {
    // The safe direction: a type added next month shows up in the badge until
    // somebody deliberately decides it is noise.
    expect(notificationKind('some_future_event')).toBe('actionable')
  })
})

describe('grouping', () => {
  it('folds repeats of the same event into one line', () => {
    const groups = groupNotifications([
      row({ created_at: iso(0) }),
      row({ created_at: iso(60_000) }),
      row({ created_at: iso(120_000) }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(3)
    expect(groups[0].unread).toBe(3)
    expect(groups[0].title).toBe('New lead from Meta')
  })

  it('keeps two different destinations apart', () => {
    // Two overdue invoices are two jobs; folding them would hide one behind
    // a count.
    const groups = groupNotifications([
      row({ type: 'invoice_overdue', link: '/dashboard/invoices?focus=1' }),
      row({ type: 'invoice_overdue', link: '/dashboard/invoices?focus=2' }),
    ])
    expect(groups).toHaveLength(2)
  })

  it('keeps different types apart even with the same link', () => {
    const groups = groupNotifications([
      row({ type: 'invoice_overdue', link: '/x' }),
      row({ type: 'followup_escalated', link: '/x' }),
    ])
    expect(groups).toHaveLength(2)
  })

  it('does not fold yesterday’s story into today’s', () => {
    const groups = groupNotifications([
      row({ created_at: iso(0) }),
      row({ created_at: iso(GROUP_WINDOW_MS + 1000) }),
    ])
    expect(groups).toHaveLength(2)
  })

  it('folds a chain that stretches past the window one step at a time', () => {
    // Each row is inside the window of the group's newest member, so the
    // chain stays one story — the alternative is a group that splits
    // differently depending on when you happen to look at it.
    const groups = groupNotifications([
      row({ created_at: iso(0) }),
      row({ created_at: iso(GROUP_WINDOW_MS - 1) }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(2)
  })

  it('reports the newest first regardless of input order', () => {
    const [newest, oldest] = [row({ type: 'a', created_at: iso(0) }), row({ type: 'b', created_at: iso(5_000) })]
    expect(groupNotifications([oldest, newest])[0].type).toBe('a')
  })

  it('counts only the unread members', () => {
    const g = groupNotifications([row({ read: true }), row({ read: false })])[0]
    expect(g.count).toBe(2)
    expect(g.unread).toBe(1)
  })

  it('gives every row id for "mark this group read"', () => {
    const g = groupNotifications([row({ id: 'x' }), row({ id: 'y' })])[0]
    expect(groupRowIds(g).sort()).toEqual(['x', 'y'])
  })

  it('survives a malformed timestamp without losing the row', () => {
    const groups = groupNotifications([row({ created_at: 'not a date' })])
    expect(groups).toHaveLength(1)
  })

  it('has nothing to group when there is nothing', () => {
    expect(groupNotifications([])).toEqual([])
  })
})

describe('metrics', () => {
  it('separates what the badge should count from the rest', () => {
    const m = notificationMetrics([
      row({ type: 'invoice_overdue', read: false }),
      row({ type: 'social_post_published', read: false }),
      row({ type: 'invoice_overdue', read: true }),
    ], NOW)
    expect(m.total).toBe(3)
    expect(m.unread).toBe(2)
    // The published-post line is shown but not shouted about.
    expect(m.actionableUnread).toBe(1)
  })

  it('names the backlog that is being ignored rather than queued', () => {
    const m = notificationMetrics([
      row({ created_at: iso(IGNORED_AFTER_MS + 1000) }),
      row({ created_at: iso(60_000) }),
    ], NOW)
    expect(m.ignored).toBe(1)
  })

  it('never counts a read row', () => {
    const m = notificationMetrics([row({ read: true, created_at: iso(IGNORED_AFTER_MS * 2) })], NOW)
    expect(m).toEqual({ total: 1, unread: 0, actionableUnread: 0, ignored: 0 })
  })
})

describe('snooze', () => {
  it('offers lengths someone would actually pick', () => {
    expect(SNOOZE_OPTIONS.length).toBeGreaterThan(1)
    expect(SNOOZE_OPTIONS.every(o => o.ms > 0 && o.label)).toBe(true)
  })

  it('hides a key until its time comes', () => {
    const map = withSnooze({}, 'k', 60_000, NOW)
    expect(isSnoozed(map, 'k', NOW)).toBe(true)
    expect(isSnoozed(map, 'k', NOW + 60_001)).toBe(false)
  })

  it('forgets expired entries so the map cannot grow forever', () => {
    const map = { old: NOW - 1, live: NOW + 60_000 }
    expect(pruneSnoozes(map, NOW)).toEqual({ live: NOW + 60_000 })
  })

  it('ignores a corrupt entry rather than hiding something indefinitely', () => {
    const map = { bad: Number.NaN, worse: 'soon' } as unknown as Record<string, number>
    expect(pruneSnoozes(map, NOW)).toEqual({})
  })

  it('extends rather than stacks when re-snoozed', () => {
    const once = withSnooze({}, 'k', 60_000, NOW)
    const again = withSnooze(once, 'k', 120_000, NOW)
    expect(again.k).toBe(NOW + 120_000)
  })

  it('un-snoozes on demand', () => {
    expect(withoutSnooze(withSnooze({}, 'k', 60_000, NOW), 'k')).toEqual({})
  })

  it('says nothing is snoozed when nothing is', () => {
    expect(isSnoozed({}, 'k', NOW)).toBe(false)
  })
})
