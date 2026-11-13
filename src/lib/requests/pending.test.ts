import { describe, expect, it } from 'vitest'
import { isFromWhatsApp, pendingByClient, pendingStage, pendingTotals, unmatchedListNames, type PendingRequest } from './pending'

const NOW = new Date('2026-11-10T09:00:00Z')
let n = 0
function req(over: Partial<PendingRequest> = {}): PendingRequest {
  n++
  return {
    id: `r${n}`, ref_no: n, title: `Request ${n}`, status: 'submitted', created_at: '2026-11-09T09:00:00Z', due_date: null,
    archived_at: null, description: null, client_id: 'sea', client_name: 'Sea Star Supermarket', submitter_name: null, ...over,
  }
}

describe('pending stage', () => {
  it('sorts every status into a stage or out', () => {
    expect(['submitted', 'under_review', 'approved'].map(pendingStage)).toEqual(['not_started', 'not_started', 'not_started'])
    expect(['started', 'in_progress'].map(pendingStage)).toEqual(['in_progress', 'in_progress'])
    expect(['waiting_for_content', 'revision_requested', 'delivered'].map(pendingStage)).toEqual(['with_client', 'with_client', 'with_client'])
    expect(['completed', 'cancelled', 'rejected', 'archived', 'anything'].map(pendingStage)).toEqual([null, null, null, null, null])
  })
})

describe('pending by client', () => {
  it('counts per client and puts the longest unanswered wait first', () => {
    const rows = pendingByClient([
      req({ status: 'submitted', created_at: '2026-11-08T09:00:00Z', description: 'From WhatsApp · Sea Star group · sent by Rahul\n\nflyer' }),
      req({ status: 'in_progress', due_date: '2026-11-05' }),
      req({ status: 'delivered', due_date: '2026-11-01' }),
      req({ status: 'completed' }),
      req({ status: 'submitted', archived_at: '2026-11-09T10:00:00Z' }),
      req({ client_id: 'gw', client_name: 'Goodwill Hypermarket', status: 'approved', created_at: '2026-11-01T09:00:00Z' }),
      req({ client_id: 'tm', client_name: 'Total Market', status: 'started' }),
    ], ['sea star supermarket'], NOW)

    expect(rows.map(r => r.name)).toEqual(['Goodwill Hypermarket', 'Sea Star Supermarket', 'Total Market'])
    const sea = rows[1]
    expect(sea).toMatchObject({ notStarted: 1, inProgress: 1, withClient: 1, overdue: 1, fromWhatsApp: 1, oldestWaitDays: 2, hasListedChat: true, matched: true })
    // Delivered work past its date is the client's wait, not ours, so it is not counted overdue.
    expect(sea.items.map(i => i.stage)).toEqual(['not_started', 'in_progress', 'with_client'])
    expect(sea.items[1].overdue).toBe(true)
    expect(sea.items[2].overdue).toBe(false)
    expect(rows[0]).toMatchObject({ oldestWaitDays: 9, hasListedChat: false })
    expect(pendingTotals(rows)).toEqual({ clients: 3, notStarted: 2, inProgress: 2, withClient: 1, overdue: 1 })
  })

  it('groups requests with no matched client by the name that was given', () => {
    const rows = pendingByClient([
      req({ client_id: null, client_name: null, submitter_name: 'New Shop' }),
      req({ client_id: null, client_name: null, submitter_name: ' new  shop ' }),
      req({ client_id: null, client_name: null, submitter_name: null }),
    ], [], NOW)
    expect(rows.map(r => [r.name, r.notStarted, r.matched])).toEqual([['New Shop', 2, false], ['No client', 1, false]])
  })

  it('is empty when nothing is pending', () => {
    expect(pendingByClient([req({ status: 'completed' })], [], NOW)).toEqual([])
    expect(pendingTotals([])).toEqual({ clients: 0, notStarted: 0, inProgress: 0, withClient: 0, overdue: 0 })
  })
})

describe('helpers', () => {
  it('spots WhatsApp captures and allow-list names that match no client', () => {
    expect(isFromWhatsApp('From WhatsApp · group')).toBe(true)
    expect(isFromWhatsApp('  From WhatsApp')).toBe(true)
    expect(isFromWhatsApp('Sent from WhatsApp')).toBe(false)
    expect(isFromWhatsApp(null)).toBe(false)
    expect(unmatchedListNames(['Sea Star Supermarket', 'Seastar Supermrket', '', 'seastar supermrket '], ['sea star  supermarket', 'Goodwill']))
      .toEqual(['Seastar Supermrket', 'seastar supermrket'])
  })
})
