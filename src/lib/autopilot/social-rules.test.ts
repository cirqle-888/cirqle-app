import { describe, it, expect } from 'vitest'
import {
  addDays, answerBudget, automatedRunNote, daysInMonth, draftsDue, monthHalves, monthLabel, nextMonthStart,
  pickDraftCandidates, pickDuePosts, type DraftCandidateRow, type PlanItemRow,
} from './social-rules'
import { autopilotOn } from './switches'

const post = (over: Partial<PlanItemRow>): PlanItemRow => ({
  id: 'p', calendar_id: 'active', scheduled_date: '2026-11-25', title: 'Guest reactions', status: 'planned', request_id: null, ...over,
})

describe('posts due for designers', () => {
  const active = new Set(['active'])
  it('sends planned posts whose deadline (date minus lead days) has come', () => {
    const r = pickDuePosts([
      post({ id: 'due', scheduled_date: '2026-11-23' }),
      post({ id: 'today', scheduled_date: '2026-11-21' }),
      post({ id: 'later', scheduled_date: '2026-11-24' }),
    ], active, 2, '2026-11-21')
    expect(r.due.map(p => p.id)).toEqual(['today', 'due'])
  })
  it('never sends drafts, past dates, ideas, sent or cancelled posts', () => {
    const r = pickDuePosts([
      post({ id: 'draft-plan', calendar_id: 'draft' }),
      post({ id: 'past', scheduled_date: '2026-11-20' }),
      post({ id: 'idea', scheduled_date: null }),
      post({ id: 'sent', request_id: 'r1' }),
      post({ id: 'task', task_id: 't1' }),
      post({ id: 'cancelled', status: 'cancelled' }),
    ], active, 30, '2026-11-21')
    expect(r.due).toEqual([])
  })
  it('holds back empty trend slots and reports them', () => {
    const r = pickDuePosts([post({ id: 'slot', title: 'TREND SLOT' })], active, 5, '2026-11-21')
    expect(r.due).toEqual([])
    expect(r.emptyTrendSlots.map(p => p.id)).toEqual(['slot'])
  })
})

describe('next month drafts', () => {
  const row = (over: Partial<DraftCandidateRow>): DraftCandidateRow => ({
    clientId: 'c', name: 'Sea Star', hasCard: true, thisMonthItems: 12, nextPlan: null,
    drafted: false, failedAttempts: 0, triedToday: false, ...over,
  })
  it('drafts working social clients whose next month is blank', () => {
    const picked = pickDraftCandidates([
      row({ clientId: 'ok' }),
      row({ clientId: 'empty-draft', nextPlan: { status: 'draft', items: 0 } }),
      row({ clientId: 'no-card', hasCard: false }),
      row({ clientId: 'quiet', thisMonthItems: 0 }),
      row({ clientId: 'planned', nextPlan: { status: 'active', items: 0 } }),
      row({ clientId: 'filled', nextPlan: { status: 'draft', items: 3 } }),
      row({ clientId: 'done', drafted: true }),
      row({ clientId: 'gave-up', failedAttempts: 3 }),
      row({ clientId: 'tried', triedToday: true, failedAttempts: 1 }),
    ])
    expect(picked.map(r => r.clientId).sort()).toEqual(['empty-draft', 'ok'])
  })
  it('tries fresh clients before ones that failed', () => {
    const picked = pickDraftCandidates([row({ clientId: 'b', name: 'B', failedAttempts: 1 }), row({ clientId: 'a', name: 'Z' })])
    expect(picked.map(r => r.clientId)).toEqual(['a', 'b'])
  })
  it('starts on the 10th', () => {
    expect(draftsDue('2026-11-09')).toBe(false)
    expect(draftsDue('2026-11-10')).toBe(true)
  })
})

describe('month helpers', () => {
  it('work across year ends and month lengths', () => {
    expect(nextMonthStart('2026-12-31')).toBe('2027-01-01')
    expect(nextMonthStart('2026-11-21')).toBe('2026-12-01')
    expect(monthLabel('2026-12-01')).toBe('December 2026')
    expect(daysInMonth('2028-02-01')).toBe(29)
    expect(addDays('2026-11-30', 2)).toBe('2026-12-02')
    expect(monthHalves('2026-02-01')).toEqual([{ from: '2026-02-01', to: '2026-02-15' }, { from: '2026-02-16', to: '2026-02-28' }])
  })
  it('keeps prompt plus answer under the free plan limit', () => {
    expect(answerBudget(2000)).toBe(5200)
    expect(answerBudget(3000)).toBe(4700)
    expect(answerBudget(7000)).toBe(1500)
  })
  it('tells the AI it cannot browse and which dates to plan', () => {
    const note = automatedRunNote({ from: '2026-12-16', to: '2026-12-31' }, '2026-12-01', ['Guest reactions'])
    expect(note).toContain('2026-12-16 to 2026-12-31')
    expect(note).toContain('cannot search the web')
    expect(note).toContain('do not repeat these ideas): Guest reactions')
  })
})

describe('automation switches', () => {
  it('default on, and can be turned off', () => {
    expect(autopilotOn({}, 'autopilot_send_planned_posts')).toBe(true)
    expect(autopilotOn({ autopilot_send_planned_posts: 'off' }, 'autopilot_send_planned_posts')).toBe(false)
  })
})
