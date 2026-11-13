import { describe, expect, it } from 'vitest'
import {
  automationFailures, buildOwnerCheck, daysBetween, effectiveDueISO, escalationStage, escalationToSend,
  fallingClients, highestSentStages, invoiceRecordIssues, isMondayISO, overdueRequests, overdueSummary,
  ownerCheckLines, parseStageKey, quietClients, stageKey, unsentInvoices,
  type ClientLite, type InvoiceLite, type LatestFollowup, type TaskLite,
} from './rules'

const TODAY = '2026-11-10'

function inv(over: Partial<InvoiceLite> = {}): InvoiceLite {
  return {
    id: 'i1', invoice_number: 'INV-1', status: 'sent', issue_date: '2026-10-01', due_date: '2026-10-31',
    total_inr: 1000, paid_inr: 0, client_id: 'c1', client_name: 'Client One', ...over,
  }
}

function fu(over: Partial<LatestFollowup> = {}): LatestFollowup {
  return { promised_date: null, next_followup_date: null, created_at: '2026-11-01T10:00:00Z', ...over }
}

describe('dates', () => {
  it('counts whole days across months and years', () => {
    expect(daysBetween('2026-10-31', TODAY)).toBe(10)
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1)
    expect(daysBetween('2026-11-10T23:59:00Z', TODAY)).toBe(0)
    expect(daysBetween(null, TODAY)).toBeNull()
  })

  it('knows Mondays', () => {
    expect(isMondayISO('2026-11-09')).toBe(true)
    expect(isMondayISO(TODAY)).toBe(false)
    expect(isMondayISO('2026-11-16')).toBe(true)
    expect(isMondayISO('1970-01-05')).toBe(true)
  })
})

describe('effective due date', () => {
  it('uses the due date, else net-30 from issue', () => {
    expect(effectiveDueISO({ issue_date: '2026-10-01', due_date: '2026-10-15' })).toBe('2026-10-15')
    expect(effectiveDueISO({ issue_date: '2026-10-01', due_date: null })).toBe('2026-10-31')
    expect(effectiveDueISO({ issue_date: null, due_date: null })).toBeNull()
  })

  it('ignores a due date earlier than the issue date', () => {
    // INV-2611-015 in production: issued 1 Nov, due 1 Sep.
    expect(effectiveDueISO({ issue_date: '2026-11-01', due_date: '2026-09-01' })).toBe('2026-12-01')
  })
})

describe('escalation', () => {
  it('maps days overdue to the highest stage reached', () => {
    expect(escalationStage(null)).toBe(0)
    expect(escalationStage(6)).toBe(0)
    expect(escalationStage(7)).toBe(7)
    expect(escalationStage(13)).toBe(7)
    expect(escalationStage(14)).toBe(14)
    expect(escalationStage(45)).toBe(30)
  })

  it('sends only the highest stage, once', () => {
    const old = inv({ issue_date: '2026-08-31', due_date: '2026-09-30' }) // 41 days overdue
    expect(escalationToSend(old, undefined, 0, TODAY)).toBe(30)
    expect(escalationToSend(old, undefined, 30, TODAY)).toBe(0)
    const mid = inv({ due_date: '2026-10-25' }) // 16 days
    expect(escalationToSend(mid, undefined, 7, TODAY)).toBe(14)
    expect(escalationToSend(mid, undefined, 14, TODAY)).toBe(0)
  })

  it('holds the 7 and 14-day notices while someone is handling it, never the 30-day one', () => {
    const handled = fu({ promised_date: '2026-11-15' })
    expect(escalationToSend(inv({ due_date: '2026-10-25' }), handled, 0, TODAY)).toBe(0)
    expect(escalationToSend(inv({ due_date: '2026-10-25' }), fu({ next_followup_date: TODAY }), 0, TODAY)).toBe(0)
    expect(escalationToSend(inv({ issue_date: '2026-08-31', due_date: '2026-09-30' }), handled, 0, TODAY)).toBe(30)
    // A promise already in the past does not count as handling.
    expect(escalationToSend(inv({ due_date: '2026-10-25' }), fu({ promised_date: '2026-11-05' }), 0, TODAY)).toBe(14)
  })

  it('never escalates drafts, paid-up or not-yet-due invoices', () => {
    expect(escalationToSend(inv({ status: 'draft', issue_date: '2026-08-01', due_date: '2026-09-01' }), undefined, 0, TODAY)).toBe(0)
    expect(escalationToSend(inv({ issue_date: '2026-08-01', due_date: '2026-09-01', paid_inr: 1000 }), undefined, 0, TODAY)).toBe(0)
    expect(escalationToSend(inv({ due_date: '2026-11-20' }), undefined, 0, TODAY)).toBe(0)
  })

  it('round-trips stage keys and finds the highest stage sent', () => {
    expect(parseStageKey(stageKey('abc-1', 14))).toEqual({ invoiceId: 'abc-1', stage: 14 })
    expect(parseStageKey('invoice_overdue:abc')).toBeNull()
    expect(parseStageKey(null)).toBeNull()
    const m = highestSentStages([stageKey('a', 7), stageKey('a', 30), stageKey('b', 14), 'other', null])
    expect(m.get('a')).toBe(30)
    expect(m.get('b')).toBe(14)
    expect(m.has('c')).toBe(false)
  })
})

describe('overdue summary', () => {
  it('buckets, totals, missed promises and stale contact', () => {
    const invoices = [
      inv({ id: 'a', due_date: '2026-11-05', total_inr: 500 }),             // 5 days
      inv({ id: 'b', due_date: '2026-10-20', total_inr: 2000, paid_inr: 500 }), // 21 days, 1,500 owed
      inv({ id: 'c', issue_date: '2026-07-01', due_date: '2026-08-01', total_inr: 3000 }), // 101 days
      inv({ id: 'd', due_date: '2026-12-01', total_inr: 900 }),             // not due
      inv({ id: 'e', status: 'paid', issue_date: '2026-07-01', due_date: '2026-08-01' }),
    ]
    const latest = new Map<string, LatestFollowup>([
      ['a', fu({ created_at: '2026-11-08T00:00:00Z' })],
      ['b', fu({ promised_date: '2026-11-01', created_at: '2026-10-25T00:00:00Z' })],
    ])
    const s = overdueSummary(invoices, latest, TODAY)
    expect(s.buckets['1-7']).toEqual({ count: 1, amountInr: 500 })
    expect(s.buckets['15-30']).toEqual({ count: 1, amountInr: 1500 })
    expect(s.buckets['30+']).toEqual({ count: 1, amountInr: 3000 })
    expect(s.totalCount).toBe(3)
    expect(s.totalInr).toBe(5000)
    expect(s.promisesMissed).toBe(1)
    expect(s.noRecentContact).toBe(2) // b (16 days ago) and c (never)
    expect(s.top.map(t => t.invoiceId)).toEqual(['c', 'b', 'a'])
  })
})

describe('unsent invoices', () => {
  it('flags drafts dated 3+ days ago and ignores future-dated drafts', () => {
    const list = unsentInvoices([
      inv({ id: 'x', status: 'draft', issue_date: '2026-11-01', total_inr: 6200 }),
      inv({ id: 'y', status: 'reviewed', issue_date: '2026-11-08' }),
      inv({ id: 'z', status: 'draft', issue_date: '2026-12-01' }),
      inv({ id: 's', status: 'sent', issue_date: '2026-11-01' }),
    ], TODAY)
    expect(list.map(i => i.invoiceId)).toEqual(['x'])
    expect(list[0].daysWaiting).toBe(9)
  })
})

describe('clients', () => {
  const clients: ClientLite[] = [
    { id: 'reg', name: 'Regular', is_active: true },
    { id: 'busy', name: 'Busy', is_active: true },
    { id: 'once', name: 'One-off', is_active: true },
    { id: 'gone', name: 'Inactive', is_active: false },
    { id: 'slow', name: 'Slowing', is_active: true },
  ]
  const t = (client_id: string, task_date: string, value_inr = 1000): TaskLite => ({ client_id, task_date, value_inr })
  const tasks: TaskLite[] = [
    // Regular: three months of work, nothing since 1 Oct.
    t('reg', '2026-08-05'), t('reg', '2026-09-05'), t('reg', '2026-10-01', 4000),
    // Busy: steady and recent.
    t('busy', '2026-08-05'), t('busy', '2026-09-05'), t('busy', '2026-10-05'), t('busy', '2026-11-05'),
    // One-off: one month only.
    t('once', '2026-07-01', 9000),
    // Inactive client is never reported.
    t('gone', '2026-07-01'), t('gone', '2026-08-01'), t('gone', '2026-09-01'),
    // Slowing: 4,000 a month before, 500 a month recently, still active this month.
    t('slow', '2026-06-01', 4000), t('slow', '2026-07-01', 4000), t('slow', '2026-08-01', 4000),
    t('slow', '2026-09-01', 4000), t('slow', '2026-11-01', 1000),
    // Outside the window entirely.
    t('busy', '2025-01-01', 99999),
    { client_id: null, task_date: '2026-11-01', value_inr: 100 },
  ]

  it('reports regular clients that went quiet', () => {
    const q = quietClients(clients, tasks, TODAY)
    expect(q.map(c => c.clientId)).toEqual(['reg'])
    expect(q[0]).toMatchObject({ lastTaskDate: '2026-10-01', daysSilent: 40, activeMonths: 3, monthlyAvgInr: 2000 })
  })

  it('reports clients spending less than half their usual, skipping excluded ones', () => {
    const f = fallingClients(clients, tasks, TODAY)
    expect(f.map(c => c.clientId)).toEqual(['slow'])
    expect(f[0]).toMatchObject({ recentMonthlyInr: 500, priorMonthlyInr: 4000, dropPct: 88 })
    expect(fallingClients(clients, tasks, TODAY, new Set(['slow']))).toEqual([])
  })
})

describe('requests, records and automations', () => {
  it('lists open requests past their due date', () => {
    const r = overdueRequests([
      { id: '1', ref_no: 1, title: 'Late', status: 'started', due_date: '2026-11-01', client_name: 'A' },
      { id: '2', ref_no: 2, title: 'Done', status: 'completed', due_date: '2026-11-01', client_name: 'A' },
      { id: '3', ref_no: 3, title: 'Today', status: 'submitted', due_date: TODAY, client_name: 'A' },
      { id: '4', ref_no: 4, title: 'No date', status: 'submitted', due_date: null, client_name: 'A' },
    ], TODAY)
    expect(r.map(x => x.id)).toEqual(['1'])
    expect(r[0].daysLate).toBe(9)
  })

  it('finds impossible invoice dates', () => {
    const issues = invoiceRecordIssues([
      inv({ id: 'a', issue_date: '2026-11-01', due_date: '2026-09-01' }),
      inv({ id: 'b', issue_date: '2026-12-01', due_date: '2026-12-31' }),
      inv({ id: 'c', status: 'draft', issue_date: '2026-12-01', due_date: '2026-12-31' }),
      inv({ id: 'd', status: 'cancelled', issue_date: '2026-11-01', due_date: '2026-09-01' }),
    ], TODAY)
    expect(issues.map(i => `${i.invoiceId}:${i.kind}`)).toEqual(['a:due_before_issue', 'b:sent_future_dated'])
  })

  it('reports only automations whose latest run failed', () => {
    const f = automationFailures([
      { cron_name: 'social-sync', ran_at: '2026-11-09T02:30:00Z', ok: false, error: 'token expired' },
      { cron_name: 'social-sync', ran_at: '2026-11-08T02:30:00Z', ok: false, error: 'token expired' },
      { cron_name: 'ad-sync', ran_at: '2026-11-08T03:00:00Z', ok: false, error: 'timeout' },
      { cron_name: 'ad-sync', ran_at: '2026-11-09T03:00:00Z', ok: true, error: null },
    ])
    expect(f).toEqual([{ name: 'social-sync', failedRuns: 2, lastError: 'token expired', lastFailedAt: '2026-11-09T02:30:00Z' }])
  })
})

describe('owner check', () => {
  it('summarises a week and leaves empty sections out', () => {
    const check = buildOwnerCheck({
      invoices: [
        inv({ id: 'd1', status: 'draft', issue_date: '2026-11-01', due_date: '2026-12-01', total_inr: 3000 }),
        inv({ id: 'o1', issue_date: '2026-08-31', due_date: '2026-09-30', total_inr: 2000 }),
      ],
      latestFollowups: new Map(),
      tasks: [],
      clients: [],
      requests: [],
      cashbook: { uncategorised: 2, unreviewed: 0 },
      cronRuns: [],
    }, TODAY)
    expect(check.attentionCount).toBe(3) // 1 unsent + 1 over 14 days + uncategorised entries
    expect(ownerCheckLines(check)).toEqual([
      '1 invoice not sent yet (₹3,000)',
      '1 overdue (₹2,000), 1 more than 14 days',
      '1 overdue with no contact in 7 days',
      '2 cash book entries without a category',
    ])
    expect(ownerCheckLines(check, false)[0]).toBe('1 invoice not sent yet')
  })

  it('is empty on a clean week', () => {
    const check = buildOwnerCheck({
      invoices: [], latestFollowups: new Map(), tasks: [], clients: [], requests: [],
      cashbook: { uncategorised: 0, unreviewed: 0 }, cronRuns: [],
    }, TODAY)
    expect(check.attentionCount).toBe(0)
    expect(ownerCheckLines(check)).toEqual([])
  })
})
