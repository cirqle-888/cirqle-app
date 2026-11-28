/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/sync/integrity', () => ({ syncDraftInvoices: vi.fn() }))
vi.mock('@/lib/tasks/derived-billing-sync', () => ({ resyncDerivedForSource: vi.fn() }))
vi.mock('@/lib/analytics/invalidate', () => ({ invalidateAnalyticsForDates: vi.fn() }))
vi.mock('@/lib/requests/task-sync', () => ({ syncRequestStatusFromTask: vi.fn(async () => {}) }))
vi.mock('@/lib/activity/log', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('@/lib/supabase/server', () => ({ fetchAll: async (q: any) => q.run() }))
vi.mock('@/lib/push/send', () => ({ sendWebPush: vi.fn(async () => {}) }))

import { bucketOf, buildTeamPending, formatPendingMessage, formatTeamSummary, sendPendingReminders } from './team-pending'

const today = '2026-11-25'
const employees = [
  { id: 'e-owner', cqid: 'CQ001' },
  { id: 'e-ajid', cqid: 'CQ002' },
  { id: 'e-gone', cqid: 'CQ009', archived: true },
]
const requests = [
  { ref_no: 141, title: 'Neha - Tashi (Combo)', status: 'submitted', due_date: '2026-11-24', assigned_employee_id: 'e-ajid', promoted_task_id: null, client: 'Sea Star Catering and Hotel' },
  { ref_no: 140, title: 'Semi-final story', status: 'submitted', due_date: '2026-11-25', assigned_employee_id: 'e-ajid', promoted_task_id: null, client: 'Sea Star Catering and Hotel' },
  { ref_no: 130, title: 'Waiting on photos', status: 'waiting_for_content', due_date: '2026-11-20', assigned_employee_id: 'e-ajid', promoted_task_id: null, client: 'Total Market' },
  { ref_no: 129, title: 'Product Label Design', status: 'submitted', due_date: null, assigned_employee_id: null, promoted_task_id: null, client: null },
  { ref_no: 120, title: 'Became a task', status: 'started', due_date: '2026-11-21', assigned_employee_id: 'e-ajid', promoted_task_id: 't-1', client: 'Sea Star Catering and Hotel' },
  { ref_no: 100, title: 'Done already', status: 'completed', due_date: '2026-11-01', assigned_employee_id: 'e-ajid', promoted_task_id: null, client: null },
  { ref_no: 99, title: 'Archived person', status: 'submitted', due_date: '2026-11-01', assigned_employee_id: 'e-gone', promoted_task_id: null, client: null },
]
const tasks = [
  { id: 't-1', task_number: 2076, title: 'Sweet Number --63', status: 'pending', task_date: '2026-11-27', client: 'Sea Star Supermarket', assignees: ['e-ajid', 'e-ajid'] },
]

describe('bucketOf', () => {
  it('sorts by due date against today', () => {
    expect(bucketOf('2026-11-24', 'submitted', today)).toBe('late')
    expect(bucketOf(today, 'submitted', today)).toBe('today')
    expect(bucketOf('2026-11-28', 'submitted', today)).toBe('soon')
    expect(bucketOf('2026-11-29', 'submitted', today)).toBe('later')
    expect(bucketOf(null, 'submitted', today)).toBe('no_date')
    expect(bucketOf('2026-11-01', 'waiting_for_content', today)).toBe('waiting_client')
  })
})

describe('buildTeamPending', () => {
  const t = buildTeamPending({ today, employees, requests, tasks })

  it('groups open work by person, skipping finished, promoted and archived', () => {
    expect(t.people.map(p => p.cqid)).toEqual(['CQ002'])
    const refs = t.people[0].items.map(i => i.ref)
    expect(refs).toEqual(['REQ-0141', 'REQ-0140', '#2076', 'REQ-0130'])
    expect(t.people[0].counts).toMatchObject({ late: 1, today: 1, soon: 1, waiting_client: 1 })
  })

  it('lists unassigned open requests apart', () => {
    expect(t.unassigned.map(i => i.ref)).toEqual(['REQ-0129'])
  })

  it('writes a shareable message with CQID only', () => {
    const msg = formatPendingMessage(t.people[0], today)
    expect(msg.split('\n')[0]).toBe('CQ002 · ഇന്നത്തെ pending (25 Nov)')
    expect(msg).toContain('വൈകിയത് / Late (1):')
    expect(msg).toContain('1. REQ-0141 Neha - Tashi (Combo) · Sea Star Catering and Hotel · 24 Nov')
    expect(msg).toContain('2. REQ-0140 Semi-final story · Sea Star Catering and Hotel')
    expect(msg).toContain('You have 1 late, 1 due today, 1 in the next few days, 1 waiting for the client.')
    expect(msg).toContain('https://app.cirqle.work/dashboard/my-work')
    const summary = formatTeamSummary(t)
    expect(summary).toContain('CQ002: 4 pending, 1 late, 1 today')
    expect(summary).toContain('• REQ-0129 Product Label Design')
  })

  it('says all clear when nobody has work', () => {
    expect(formatTeamSummary(buildTeamPending({ today, employees, requests: [], tasks: [] }))).toContain('Nobody has pending work')
  })
})

/** Minimal in-memory query builder for the send path. */
function fakeAdmin(seed: Record<string, any[]>) {
  const db: Record<string, any[]> = { conversations: [], conversation_members: [], messages: [], ...seed }
  let n = 0
  const from = (table: string) => {
    const filters: ((r: any) => boolean)[] = []
    let op: 'select' | 'insert' | 'update' = 'select'
    let payload: any = null
    let single = false
    const q: any = {
      select: () => q,
      eq: (c: string, v: any) => { filters.push(r => r[c] === v); return q },
      ilike: (c: string, v: any) => { filters.push(r => String(r[c]).toLowerCase() === String(v).toLowerCase()); return q },
      is: (c: string, v: any) => { filters.push(r => (r[c] ?? null) === v); return q },
      in: (c: string, v: any[]) => { filters.push(r => v.includes(r[c])); return q },
      contains: (c: string, v: any) => { filters.push(r => Object.entries(v).every(([k, x]) => r[c]?.[k] === x)); return q },
      limit: () => q,
      insert: (row: any) => { op = 'insert'; payload = row; return q },
      update: (row: any) => { op = 'update'; payload = row; return q },
      single: () => { single = true; return q },
      maybeSingle: () => { single = true; return q },
      run: () => {
        if (op === 'insert') {
          const rows = (Array.isArray(payload) ? payload : [payload]).map(r => ({ id: `${table}-${++n}`, ...r }))
          db[table].push(...rows)
          return { data: single ? rows[0] : rows, error: null }
        }
        let rows = db[table].filter(r => filters.every(f => f(r)))
        if (op === 'update') rows.forEach(r => Object.assign(r, payload))
        if (table === 'conversation_members') rows = rows.map(r => ({ ...r, conversation: db.conversations.find(c => c.id === r.conversation_id) }))
        if (table === 'task_requests') rows = rows.map(r => ({ ...r, client: r.client ? { name: r.client } : null }))
        if (table === 'tasks') rows = rows.map(r => ({ ...r, client: r.client ? { name: r.client } : null, assignments: r.assignees.map((id: string) => ({ employee_id: id })) }))
        return { data: single ? rows[0] ?? null : rows, error: null }
      },
      then: (res: any, rej: any) => Promise.resolve(q.run()).then(res, rej),
    }
    return q
  }
  return { db, admin: { from } as any }
}

describe('sendPendingReminders', () => {
  const seed = () => ({
    employees: [
      { id: 'e-owner', cqid: 'CQ001', role: 'super_admin', is_archived: false },
      { id: 'e-ajid', cqid: 'CQ002', role: 'employee', is_archived: false },
    ],
    task_requests: requests.filter(r => r.assigned_employee_id !== 'e-gone'),
    tasks,
  })

  it('sends one DM per person, once a day', async () => {
    const { db, admin } = fakeAdmin(seed())
    const first = await sendPendingReminders(admin, { fromCqid: 'cq001', today })
    expect(first.ok && first.result.sent).toEqual([{ cqid: 'CQ002', items: 4, late: 1 }])
    expect(db.conversations).toHaveLength(1)
    expect(db.messages).toHaveLength(1)
    expect(db.messages[0]).toMatchObject({ sender_id: 'e-owner', metadata: { pending_reminder: today } })
    expect(db.messages[0].body).toContain('REQ-0141')

    const again = await sendPendingReminders(admin, { fromCqid: 'CQ001', today })
    expect(again.ok && again.result.skipped).toEqual([{ cqid: 'CQ002', reason: 'already sent today' }])
    expect(db.messages).toHaveLength(1)
    expect(db.conversations).toHaveLength(1)
  })

  it('refuses a sender who is not an admin', async () => {
    const { db, admin } = fakeAdmin(seed())
    const r = await sendPendingReminders(admin, { fromCqid: 'CQ002', today })
    expect(r.ok).toBe(false)
    expect(db.messages).toHaveLength(0)
  })
})
