import { describe, it, expect } from 'vitest'
import {
  buildActionQueue,
  actionQueueAttentionCount,
  type ActionQueueCaps,
  type ActionQueueKey,
} from './action-queue'

/**
 * The improvement plan states the acceptance criteria for this feature as three
 * concrete roles — "Designers see pending work/contributions; accounts see
 * collections and billing; managers see blocked work and approvals" — so those
 * are the cases tested here, not just the mechanics.
 */

const NOBODY: ActionQueueCaps = {
  isAdmin: false,
  billing: false,
  requestsReview: false,
  payroll: false,
  contributionsAll: false,
  hasEmployeeRecord: false,
}

const designer: ActionQueueCaps = { ...NOBODY, hasEmployeeRecord: true }
const accounts: ActionQueueCaps = { ...NOBODY, hasEmployeeRecord: true, billing: true }
const manager: ActionQueueCaps = { ...NOBODY, hasEmployeeRecord: true, requestsReview: true }
const admin: ActionQueueCaps = { ...NOBODY, isAdmin: true, hasEmployeeRecord: true }

/** Every bucket non-zero, so eligibility is the only thing under test. */
const ALL_COUNTS = {
  overdueInvoices: 12,
  requestsAwaiting: 3,
  myContributions: 2,
  draftsToSend: 9,
  payrollPending: 4,
  missingContributions: 7,
  myTasks: 5,
  todayTasks: 6,
  unreadNotifications: 8,
}

const keysFor = (caps: ActionQueueCaps) => buildActionQueue(caps, ALL_COUNTS).map(i => i.key)

describe('role eligibility', () => {
  it('gives a designer their own work and nothing financial', () => {
    const keys = keysFor(designer)
    expect(keys).toContain('my_contributions')
    expect(keys).toContain('my_tasks')
    expect(keys).not.toContain('overdue_invoices')
    expect(keys).not.toContain('drafts_to_send')
    expect(keys).not.toContain('payroll_review')
    expect(keys).not.toContain('requests_awaiting')
  })

  it('gives an accounts person collections and billing', () => {
    // This is the case that returned an empty dashboard before: the rows were
    // fetched behind `isAdmin ?`, so a holder of billing.view_invoices saw
    // neither the overdue queue nor the drafts waiting to go out.
    const keys = keysFor(accounts)
    expect(keys).toContain('overdue_invoices')
    expect(keys).toContain('drafts_to_send')
    expect(keys).not.toContain('payroll_review')
    expect(keys).not.toContain('requests_awaiting')
  })

  it('gives a manager the approvals queued on them', () => {
    const keys = keysFor(manager)
    expect(keys).toContain('requests_awaiting')
    expect(keys).not.toContain('overdue_invoices')
    expect(keys).not.toContain('payroll_review')
  })

  it('gives an admin every bucket', () => {
    expect(keysFor(admin).length).toBe(Object.keys(ALL_COUNTS).length)
  })

  it('shows personal buckets to anyone, financial buckets to no one by default', () => {
    // A viewer with no permissions and no employee record still gets their own
    // notifications and the day's schedule — neither reveals anything they
    // could not already open — and nothing else.
    expect(keysFor(NOBODY).sort()).toEqual(['notifications', 'today_tasks'])
  })
})

describe('ordering', () => {
  it('puts what blocks other people and costs money first', () => {
    const keys = keysFor(admin)
    const at = (k: ActionQueueKey) => keys.indexOf(k)
    expect(at('overdue_invoices')).toBeLessThan(at('drafts_to_send'))
    expect(at('requests_awaiting')).toBeLessThan(at('my_tasks'))
    expect(at('my_contributions')).toBeLessThan(at('today_tasks'))
    // Informational last — a notification worth acting on is almost always
    // already represented by a specific bucket above it.
    expect(at('notifications')).toBe(keys.length - 1)
  })

  it('is stable regardless of the order counts are supplied in', () => {
    const reversed = Object.fromEntries(Object.entries(ALL_COUNTS).reverse())
    expect(buildActionQueue(admin, reversed).map(i => i.key)).toEqual(keysFor(admin))
  })
})

describe('empty and malformed buckets', () => {
  it('drops buckets with nothing in them', () => {
    const keys = buildActionQueue(admin, { overdueInvoices: 3, draftsToSend: 0 }).map(i => i.key)
    expect(keys).toEqual(['overdue_invoices'])
  })

  it('returns an empty queue when there is genuinely nothing to do', () => {
    expect(buildActionQueue(admin, {})).toEqual([])
  })

  it('never renders a negative or fractional count', () => {
    const q = buildActionQueue(admin, { overdueInvoices: -4, draftsToSend: 2.7 })
    expect(q.find(i => i.key === 'overdue_invoices')).toBeUndefined()
    expect(q.find(i => i.key === 'drafts_to_send')?.count).toBe(2)
  })
})

describe('item content', () => {
  it('explains itself and links to the action, not a report', () => {
    const [item] = buildActionQueue(accounts, { overdueInvoices: 12 })
    expect(item.reason).toBeTruthy()
    expect(item.href).toBe('/dashboard/invoices/follow-ups')
  })

  it('caps the sample at three rows', () => {
    const [item] = buildActionQueue(accounts, { overdueInvoices: 9 }, {
      overdue_invoices: ['a', 'b', 'c', 'd', 'e'],
    })
    expect(item.items).toEqual(['a', 'b', 'c'])
  })

  it('tolerates a missing sample', () => {
    expect(buildActionQueue(accounts, { overdueInvoices: 9 })[0].items).toEqual([])
  })
})

describe('attention badge', () => {
  it('counts decisions, not the day’s schedule or unread mail', () => {
    const q = buildActionQueue(admin, { overdueInvoices: 12, todayTasks: 6, unreadNotifications: 8 })
    // 12 only — inflating the badge with a normal day's work trains people to
    // ignore the badge.
    expect(actionQueueAttentionCount(q)).toBe(12)
  })

  it('is zero when only informational buckets are present', () => {
    const q = buildActionQueue(admin, { todayTasks: 6, unreadNotifications: 8 })
    expect(q.length).toBe(2)
    expect(actionQueueAttentionCount(q)).toBe(0)
  })
})
